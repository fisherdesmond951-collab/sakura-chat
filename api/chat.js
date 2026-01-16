// api/chat.js
// Google Places + Geocoding でお店検索。
// Place Details の reviews を OpenAI で要約し、
// 各店について「読みやすい 2〜3文」の口コミベース説明を返す。

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!mapsKey) {
      return res.status(500).json({
        error: "GOOGLE_MAPS_API_KEY is not set.",
      });
    }
    if (!openaiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not set.",
      });
    }

    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body." });
    }

    const { station, genre } = parseStationGenre(text);

    // 1) 駅をジオコーディング
    const stationLoc = await geocodeToLocation(`${station} station, Japan`, mapsKey);
    if (!stationLoc) {
      return res.status(200).json({
        reply:
          `Aww… I couldn’t locate the station "${station}" 🥺\n` +
          `Try like: "Shinjuku ramen" / "Shibuya sushi" 🌸`,
      });
    }

    // 2) 駅周辺 15分徒歩圏（約1.2km）で検索
    const radiusMeters = 1200;
    const places = await nearbySearchRestaurants({
      location: stationLoc,
      radius: radiusMeters,
      keyword: genre,
      apiKey: mapsKey,
    });

    if (places.length === 0) {
      return res.status(200).json({
        reply:
          `Hmm… I couldn’t find restaurants near ${station} for "${genre}" 🥺\n` +
          `Try another genre like ramen / sushi / yakitori / cafe 🌸✨`,
      });
    }

    // 3) 評価4.0+優先
    const rated = places
      .filter((p) => typeof p.rating === "number")
      .sort((a, b) => {
        const r = (b.rating ?? 0) - (a.rating ?? 0);
        if (r !== 0) return r;
        return (b.user_ratings_total ?? 0) - (a.user_ratings_total ?? 0);
      });

    const fourPlus = rated.filter((p) => (p.rating ?? 0) >= 4.0);
    const chosenBase = fourPlus.length > 0 ? fourPlus : rated;

    // 4) 上位候補から最大5件
    const pool = chosenBase.slice(0, Math.min(10, chosenBase.length));
    shuffleInPlace(pool);
    const chosen = pool.slice(0, Math.min(5, pool.length));

    // 5) Reviews + OpenAI 要約（短め）
    const summarized = await Promise.all(
      chosen.map(async (p) => {
        const details = await placeDetailsForReviews(p.place_id, mapsKey);
        const reviewTexts = extractReviewTexts(details);
        const summary = await summarizeReviewsWithOpenAI({
          openaiKey,
          placeName: p.name,
          station,
          genre,
          reviewTexts,
        });
        return { base: p, summary };
      })
    );

    // 6) 返答
    let reply =
      `Konnichiwa! I’m Sakura-chan 🌸✨\n` +
      `Here are my picks near **${station}** for **${genre}** (within ~15 min walk)! Oishii~ 💖\n\n`;

    for (const item of summarized) {
      const p = item.base;
      const name = p.name || "Unknown Restaurant";
      const placeLoc = p.geometry?.location;
      const walkMin = estimateWalkMinutes(stationLoc, placeLoc);
      const access = Number.isFinite(walkMin) ? `Approx. ${walkMin} min walk` : `Near ${station}`;
      const mapUrl = makePlacePageUrl(p.place_id, name, p.vicinity || "", station);

      const insight =
        item.summary ||
        "Lovely flavors and a comfy vibe make this a pleasant stop for food lovers. 🌸✨";

      reply +=
        `🌸 ${name}\n` +
        `🚶 Access: Near ${station} (${access})\n` +
        `✨ Sakura’s Pick: ${insight}\n` +
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

async function placeDetailsForReviews(placeId, apiKey) {
  if (!placeId) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "reviews");
  url.searchParams.set("language", "en");
  url.searchParams.set("key", apiKey);

  const resp = await fetch(url.toString());
  if (!resp.ok) return null;

  const json = await resp.json();
  if (json.status && json.status !== "OK") return null;

  return json.result || null;
}

function extractReviewTexts(details) {
  if (!details || !Array.isArray(details.reviews)) return [];
  return details.reviews
    .map((r) => (typeof r.text === "string" ? r.text.trim() : ""))
    .filter(Boolean)
    .slice(0, 6);
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
  const mins = Math.max(1, Math.round(meters / 80));
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

/* ---------------- OpenAI Review Summarizer (short) ---------------- */

async function summarizeReviewsWithOpenAI({ openaiKey, placeName, station, genre, reviewTexts }) {
  try {
    if (!Array.isArray(reviewTexts) || reviewTexts.length === 0) return "";

    const prompt =
      `You are "Sakura-chan", a cute anime girl food guide for travelers in Japan.\n` +
      `Based ONLY on the reviews below, write a friendly 2–3 sentence description in English.\n` +
      `Do NOT mention prices or numeric ratings. Do NOT invent facts.\n` +
      `Focus on flavor, atmosphere, service, and who might enjoy this place.\n\n` +
      `Restaurant: ${placeName}\n` +
      `Nearby station: ${station}\n` +
      `Genre: ${genre}\n\n` +
      `Reviews:\n` +
      reviewTexts.map((t, i) => `(${i + 1}) ${t}`).join("\n") +
      `\n\n` +
      `Now write the description as Sakura-chan (2–3 sentences).`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are Sakura-chan, a cute anime girl food guide." },
          { role: "user", content: prompt },
        ],
        max_tokens: 160,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) return "";

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return "";
    return content.trim();
  } catch {
    return "";
  }
}
