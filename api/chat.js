// api/chat.js
// Google Places + Geocoding でお店を探し、
// Place Details の reviews を OpenAI で要約して、
// 各店について「口コミベースの詳しい説明」を英語で返す。

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
        error: "GOOGLE_MAPS_API_KEY is not set. Add it in Vercel Environment Variables.",
      });
    }
    if (!openaiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not set. Add it in Vercel Environment Variables.",
      });
    }

    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body." });
    }

    const { station, genre } = parseStationGenre(text);

    // 1) 駅の座標
    const stationLoc = await geocodeToLocation(`${station} station, Japan`, mapsKey);
    if (!stationLoc) {
      return res.status(200).json({
        reply:
          `Aww… I couldn’t locate the station "${station}" 🥺\n` +
          `Try like: "Shinjuku ramen" / "Shibuya sushi" 🌸`,
      });
    }

    // 2) 15分徒歩圏（約1.2km）でレストラン検索
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

    // 4) 上位候補からシャッフルして最大5件
    const pool = chosenBase.slice(0, Math.min(12, chosenBase.length));
    shuffleInPlace(pool);
    const chosen = pool.slice(0, Math.min(5, pool.length));

    // 5) 各店について Place Details(review) + OpenAI 要約
    const detailAndSummaryList = await Promise.all(
      chosen.map(async (p) => {
        const details = await placeDetailsForReviews(p.place_id, mapsKey);
        const reviewTexts = extractReviewTexts(details);
        const sakuraSummary = await summarizeReviewsWithOpenAI({
          openaiKey,
          placeName: p.name,
          station,
          genre,
          reviewTexts,
        });

        return { base: p, stationLoc, summary: sakuraSummary };
      })
    );

    // 6) 返答組み立て（数値レーティングは出さない）
    let reply =
      `Konnichiwa! I’m Sakura-chan 🌸✨\n` +
      `Here are my detailed picks near **${station}** for **${genre}** (within ~15 min walk)! Oishii~ 💖\n\n`;

    for (const item of detailAndSummaryList) {
      const p = item.base;
      const stationLoc2 = item.stationLoc;
      const name = p.name || "Unknown Restaurant";
      const placeLoc = p.geometry?.location;
      const walkMin = estimateWalkMinutes(stationLoc2, placeLoc);
      const access = Number.isFinite(walkMin) ? `Approx. ${walkMin} min walk` : `Near ${station}`;

      const mapUrl = makePlacePageUrl(p.place_id, name, p.vicinity || "", station);
      const reviewsCount =
        typeof p.user_ratings_total === "number" ? p.user_ratings_total : null;

      const countText =
        reviewsCount && reviewsCount >= 10
          ? `${reviewsCount}+ reviews`
          : reviewsCount
          ? `${reviewsCount} reviews`
          : "a few reviews";

      const insight =
        item.summary ||
        "Cute foodie vibes! Reviews are limited, but this spot looks promising for an adventure. 🌸✨";

      reply +=
        `🌸 ${name}\n` +
        `🚶 Access: Near ${station} (${access})\n` +
        `📝 Reviews: Based on ${countText}\n` +
        `✨ Sakura’s Detailed Insight:\n${insight}\n` +
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

/* ---------------- 基本ヘルパー ---------------- */

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
    .slice(0, 8); // 念のため最大8件まで
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

/* ---------------- OpenAI でレビュー要約 ---------------- */

async function summarizeReviewsWithOpenAI({ openaiKey, placeName, station, genre, reviewTexts }) {
  try {
    if (!Array.isArray(reviewTexts) || reviewTexts.length === 0) return "";

    const prompt =
      `You are "Sakura-chan", a cute anime girl food guide for travelers in Japan.\n` +
      `Write a detailed but concise description of this restaurant in English, based ONLY on the reviews below.\n` +
      `Style: friendly, cute, enthusiastic, with some Japanese words like "Oishii", but do NOT invent facts that are not clearly implied.\n` +
      `Do NOT mention numeric ratings or prices. Focus on flavor, atmosphere, service, crowd level, and who might enjoy it.\n\n` +
      `Restaurant name: ${placeName}\n` +
      `Nearby station: ${station}\n` +
      `Genre: ${genre}\n\n` +
      `Reviews:\n` +
      reviewTexts.map((t, i) => `(${i + 1}) ${t}`).join("\n") +
      `\n\n` +
      `Now write 3–6 sentences as Sakura-chan, starting directly with the description (no bullet points).`;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Sakura-chan, a cute anime girl who explains restaurant vibes in natural English for foreign travelers in Japan.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 320,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("OpenAI error:", resp.status, txt);
      return "";
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") return "";
    return content.trim();
  } catch (e) {
    console.error("summarizeReviewsWithOpenAI error:", e);
    return "";
  }
}
