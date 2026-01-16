// api/chat.js
// Google Places API + Geocoding API で評価4.0+優先の店を探し、
// Place Details API でレビュー（最大5件）を取得して “特徴” を要約して返す。
// リンクは /maps/place/?q=place_id: で「店ページ」表示を狙う。

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "GOOGLE_MAPS_API_KEY is not set. Add it in Vercel Environment Variables.",
      });
    }

    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "Missing 'text' in request body." });

    const { station, genre } = parseStationGenre(text);

    // 1) 駅の座標
    const stationLoc = await geocodeToLocation(`${station} station, Japan`, apiKey);
    if (!stationLoc) {
      return res.status(200).json({
        reply:
          `Aww… I couldn’t locate the station "${station}" 🥺\n` +
          `Try like: "Shinjuku ramen" / "Shibuya sushi" 🌸`,
      });
    }

    // 2) 近くのレストラン候補（15分徒歩圏 ≒ 1.2km）
    const radiusMeters = 1200;
    const places = await nearbySearchRestaurants({
      location: stationLoc,
      radius: radiusMeters,
      keyword: genre,
      apiKey,
    });

    if (places.length === 0) {
      return res.status(200).json({
        reply:
          `Hmm… I couldn’t find restaurants near ${station} for "${genre}" 🥺\n` +
          `Try another genre like ramen / sushi / yakitori / cafe 🌸✨`,
      });
    }

    // 3) 評価4.0+優先（なければ高評価順）
    const rated = places
      .filter((p) => typeof p.rating === "number")
      .sort((a, b) => {
        const r = (b.rating ?? 0) - (a.rating ?? 0);
        if (r !== 0) return r;
        return (b.user_ratings_total ?? 0) - (a.user_ratings_total ?? 0);
      });

    const fourPlus = rated.filter((p) => (p.rating ?? 0) >= 4.0);
    const chosenBase = fourPlus.length > 0 ? fourPlus : rated;

    // 4) 上位から少しランダムに最大5件
    const pool = chosenBase.slice(0, Math.min(12, chosenBase.length));
    shuffleInPlace(pool);
    const chosen = pool.slice(0, Math.min(5, pool.length));

    // 5) 各店の Place Details（reviews）を取得して特徴抽出
    const detailsList = await Promise.all(
      chosen.map(async (p) => {
        const details = await placeDetailsForReviews(p.place_id, apiKey);
        return { base: p, details };
      })
    );

    // 6) 返答組み立て（数値レーティングは出さない）
    let reply =
      `Konnichiwa! I’m Sakura-chan 🌸✨\n` +
      `Here are my picks near **${station}** for **${genre}** (within ~15 min walk)! Oishii~ 💖\n\n`;

    for (const item of detailsList) {
      const p = item.base;
      const d = item.details;

      const name = p.name || "Unknown Restaurant";
      const placeLoc = p.geometry?.location;
      const walkMin = estimateWalkMinutes(stationLoc, placeLoc);
      const access = Number.isFinite(walkMin) ? `Approx. ${walkMin} min walk` : `Near ${station}`;

      const mapUrl = makePlacePageUrl(p.place_id, name, p.vicinity || "", station);

      // 口コミテキスト（最大5件）
      const reviewTexts = (d?.reviews || [])
        .map((r) => (typeof r.text === "string" ? r.text.trim() : ""))
        .filter(Boolean);

      // 特徴抽出（ルールベース：よく出る語＋カテゴリ辞書）
      const insight = makeSakuraInsightFromReviews(reviewTexts);

      // 口コミが取れない場合のフォールバック
      const safeInsight =
        insight ||
        "Cute and tasty vibes! (Reviews are limited, but this spot looks promising!) 🌸✨";

      reply +=
        `🌸 ${name}\n` +
        `🚶 Access: Near ${station} (${access})\n` +
        `✨ Sakura’s Pick: ${safeInsight}\n` +
        `📍 Let’s go!: ${mapUrl}\n\n`;
    }

    reply += `I hope you find your favorite meal! Matane! 🌸✨`;
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("api/chat error:", err);
    return res.status(500).json({
      error: "Internal server error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ---------------- Helpers ---------------- */

function parseStationGenre(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.includes(",")) {
    const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
    return { station: parts[0] || cleaned, genre: parts.slice(1).join(" ") || "restaurants" };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { station: parts[0], genre: "restaurants" };
  return { station: parts[0], genre: parts.slice(1).join(" ").trim() || "restaurants" };
}

async function geocodeToLocation(address, apiKey) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "jp");
  url.searchParams.set("key", apiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) return null;

  const json = await resp.json();
  const first = Array.isArray(json.results) ? json.results[0] : null;
  const loc = first?.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;

  return { lat: loc.lat, lng: loc.lng };
}

async function nearbySearchRestaurants({ location, radius, keyword, apiKey }) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
  url.searchParams.set("location", `${location.lat},${location.lng}`);
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("type", "restaurant");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("language", "en");
  url.searchParams.set("region", "jp");
  url.searchParams.set("key", apiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) return [];

  const json = await resp.json();
  const results = Array.isArray(json.results) ? json.results : [];

  return results.map((p) => ({
    name: p.name,
    place_id: p.place_id,
    rating: p.rating,
    user_ratings_total: p.user_ratings_total,
    vicinity: p.vicinity,
    geometry: p.geometry,
  }));
}

// Place Details で reviews を取る（無料枠＆制限あり。最大5件程度）
async function placeDetailsForReviews(placeId, apiKey) {
  if (!placeId) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  // reviews は有効なフィールド。必要最小限だけ取る
  url.searchParams.set("fields", "reviews");
  url.searchParams.set("language", "en");
  url.searchParams.set("key", apiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) return null;

  const json = await resp.json();
  if (json.status && json.status !== "OK") return null;

  return json.result || null;
}

function makePlacePageUrl(placeId, name, vicinity, station) {
  if (placeId) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  }
  const q = `${name} ${vicinity || station} Japan`;
  return `https://www.google.com/maps/place/?q=${encodeURIComponent(q)}`;
}

function estimateWalkMinutes(origin, dest) {
  if (!origin || !dest || typeof dest.lat !== "number" || typeof dest.lng !== "number") return NaN;
  const meters = haversineMeters(origin.lat, origin.lng, dest.lat, dest.lng);
  const mins = Math.max(1, Math.round(meters / 80)); // 80 m/min ≒ 4.8km/h
  return Math.min(mins, 15);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ---------------- Review summarizer (rule-based) ---------------- */

// 口コミの上位傾向を「それっぽく」まとめる（捏造しない）
// - よく出る語を拾う
// - 料理/接客/雰囲気などのカテゴリ辞書で特徴を短くまとめる
function makeSakuraInsightFromReviews(reviewTexts) {
  if (!Array.isArray(reviewTexts) || reviewTexts.length === 0) return "";

  const text = reviewTexts.join(" ").toLowerCase();

  const buckets = [
    { label: "taste", words: ["delicious", "tasty", "flavor", "broth", "noodles", "fresh", "crispy", "juicy", "umami", "rich"] },
    { label: "service", words: ["friendly", "kind", "helpful", "staff", "service", "polite", "fast", "quick"] },
    { label: "atmosphere", words: ["cozy", "cute", "calm", "quiet", "clean", "atmosphere", "vibe", "small", "comfortable"] },
    { label: "line", words: ["line", "queue", "wait", "waiting", "busy", "crowded", "popular"] },
    { label: "value", words: ["worth", "value", "reasonable", "portions", "price", "affordable"] },
  ];

  const found = [];
  for (const b of buckets) {
    let hit = 0;
    for (const w of b.words) {
      if (text.includes(w)) hit++;
    }
    if (hit > 0) found.push({ label: b.label, score: hit });
  }

  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, 2).map((x) => x.label);

  // ネガティブっぽい語があれば「注意点」を軽く入れる（断定しない）
  const caution = /(slow|overpriced|salty|small portion|rude|noisy)/.test(text);

  const parts = [];
  if (top.includes("taste")) parts.push("Yummy flavors that people keep talking about!");
  if (top.includes("service")) parts.push("Sweet staff vibes and smooth service!");
  if (top.includes("atmosphere")) parts.push("Cozy atmosphere for a comfy meal!");
  if (top.includes("line")) parts.push("Popular spot—maybe a little wait!");
  if (top.includes("value")) parts.push("Feels worth it for many visitors!");

  if (parts.length === 0) {
    parts.push("Cute foodie vibes—reviews sound happy overall!");
  }

  let out = parts.slice(0, 2).join(" ");
  if (caution) out += " (Some reviews mention a small downside, so go with a flexible mood!)";

  return out + " 🌸✨";
}
