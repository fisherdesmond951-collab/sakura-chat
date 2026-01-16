// api/chat.js
// Google Places + Geocoding でお店検索。
// Place Details の reviews を OpenAI で超短く要約（1〜2文）して返す。
// 読みやすさ最優先・X投稿やチャット向け。

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!mapsKey || !openaiKey) {
      return res.status(500).json({
        error: "GOOGLE_MAPS_API_KEY or OPENAI_API_KEY is not set.",
      });
    }

    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body." });
    }

    const { station, genre } = parseStationGenre(text);

    const stationLoc = await geocodeToLocation(`${station} station, Japan`, mapsKey);
    if (!stationLoc) {
      return res.status(200).json({
        reply: `I couldn’t find that station, sorry 🥺 Try again like "Shinjuku ramen"! 🌸`,
      });
    }

    const places = await nearbySearchRestaurants({
      location: stationLoc,
      radius: 1200,
      keyword: genre,
      apiKey: mapsKey,
    });

    if (!places.length) {
      return res.status(200).json({
        reply: `No tasty spots found near ${station} for "${genre}" 🥺 Try another food! 🌸`,
      });
    }

    const chosen = places
      .filter((p) => typeof p.rating === "number")
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 5);

    let reply =
      `Konnichiwa! I’m Sakura-chan 🌸✨\n` +
      `Here are quick picks near **${station}** for **${genre}**!\n\n`;

    for (const p of chosen) {
      const details = await placeDetailsForReviews(p.place_id, mapsKey);
      const reviewTexts = extractReviewTexts(details);

      const summary = await summarizeReviewsWithOpenAI({
        openaiKey,
        placeName: p.name,
        station,
        genre,
        reviewTexts,
      });

      const walkMin = estimateWalkMinutes(stationLoc, p.geometry?.location);
      const access = Number.isFinite(walkMin) ? `${walkMin} min walk` : `near ${station}`;
      const mapUrl = makePlacePageUrl(p.place_id, p.name, p.vicinity || "", station);

      reply +=
        `🌸 ${p.name}\n` +
        `🚶 ${access}\n` +
        `✨ ${summary || "Looks tasty and cozy—worth a try! 🌸"}\n` +
        `📍 ${mapUrl}\n\n`;
    }

    reply += `Enjoy your meal! Matane! 🌸✨`;
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ---------------- Helpers ---------------- */

function parseStationGenre(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.includes(",")) {
    const [s, ...g] = cleaned.split(",").map((x) => x.trim());
    return { station: s, genre: g.join(" ") || "restaurants" };
  }
  const [s, ...g] = cleaned.split(" ");
  return { station: s, genre: g.join(" ") || "restaurants" };
}

async function geocodeToLocation(address, apiKey) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "jp");
  url.searchParams.set("key", apiKey);
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const loc = j.results?.[0]?.geometry?.location;
  return loc ? { lat: loc.lat, lng: loc.lng } : null;
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
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((p) => ({
    name: p.name,
    place_id: p.place_id,
    rating: p.rating,
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
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status === "OK" ? j.result : null;
}

function extractReviewTexts(details) {
  return Array.isArray(details?.reviews)
    ? details.reviews.map((r) => r.text).filter(Boolean).slice(0, 5)
    : [];
}

function makePlacePageUrl(placeId, name, vicinity, station) {
  if (placeId) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  }
  return `https://www.google.com/maps/place/?q=${encodeURIComponent(
    `${name} ${vicinity || station} Japan`
  )}`;
}

function estimateWalkMinutes(o, d) {
  if (!o || !d) return NaN;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(d.lat - o.lat);
  const dLng = toRad(d.lng - o.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(o.lat)) * Math.cos(toRad(d.lat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.min(15, Math.max(1, Math.round((R * c) / 80)));
}

/* -------- OpenAI ultra-short summary -------- */

async function summarizeReviewsWithOpenAI({ openaiKey, placeName, station, genre, reviewTexts }) {
  if (!reviewTexts.length) return "";
  const prompt =
    `You are Sakura-chan, a cute food guide.\n` +
    `Based ONLY on the reviews, write 1–2 short sentences in English.\n` +
    `No prices, no ratings, no extra details.\n\n` +
    reviewTexts.join("\n");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 90,
      temperature: 0.6,
    }),
  });

  if (!r.ok) return "";
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}
