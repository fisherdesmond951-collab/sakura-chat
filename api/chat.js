// api/chat.js
// Google Places API + Geocoding API で実データ検索し、評価4.0+を優先。
// 15分徒歩圏（約1.2km）に限定して最大5件返す。
// ★リンクは「緯度,経度」で作るので、Googleマップで必ずピンが刺さる。

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
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body." });
    }

    const { station, genre } = parseStationGenre(text);

    // 1) 駅をジオコーディングして座標取得
    const stationQuery = `${station} station, Japan`;
    const stationLoc = await geocodeToLocation(stationQuery, apiKey);
    if (!stationLoc) {
      return res.status(200).json({
        reply:
          `Aww… I couldn’t locate the station "${station}" 🥺\n` +
          `Try a clearer station name like: "Shinjuku ramen" / "Shibuya sushi" 🌸`,
      });
    }

    // 2) 駅周辺 15分徒歩圏（約1.2km）でレストラン検索
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
          `Hmm… I couldn’t find restaurants near ${station} with "${genre}" right now 🥺\n` +
          `Try another genre like "ramen", "sushi", "yakitori", "cafe" 🌸✨`,
      });
    }

    // 3) 評価4.0+を優先。なければ高評価順（レビュー数も加味）
    const rated = places
      .filter((p) => typeof p.rating === "number")
      .sort((a, b) => {
        const r = (b.rating ?? 0) - (a.rating ?? 0);
        if (r !== 0) return r;
        return (b.user_ratings_total ?? 0) - (a.user_ratings_total ?? 0);
      });

    const fourPlus = rated.filter((p) => (p.rating ?? 0) >= 4.0);
    const chosenBase = fourPlus.length > 0 ? fourPlus : rated;

    // 4) 最大5件。上位候補からシャッフルして少しランダムに
    const pool = chosenBase.slice(0, Math.min(15, chosenBase.length));
    shuffleInPlace(pool);
    const chosen = pool.slice(0, Math.min(5, pool.length));

    // 5) 返答組み立て（数値レーティングは表示しない）
    let reply =
      `Konnichiwa! I’m Sakura-chan 🌸✨\n` +
      `Here are my picks near **${station}** for **${genre}** (within ~15 min walk)! Oishii~ 💖\n\n`;

    chosen.forEach((p) => {
      const name = p.name || "Unknown Restaurant";
      const placeLoc = p.geometry?.location;
      const walkMin = estimateWalkMinutes(stationLoc, placeLoc);
      const access = Number.isFinite(walkMin) ? `Approx. ${walkMin} min walk` : `Near ${station}`;

      // ★ ここが重要：緯度経度で確実にピンが刺さるリンク
      const mapUrl = makeLatLngMapUrl(placeLoc, name, station);

      const reviewsCount =
        typeof p.user_ratings_total === "number" ? p.user_ratings_total : null;

      const vibe =
        reviewsCount && reviewsCount >= 500
          ? "Super popular — expect a little line! ✨"
          : reviewsCount && reviewsCount >= 100
          ? "Loved by many locals — yummy vibes! 🌸"
          : "Looks like a cozy gem — worth a try! 💖";

      reply +=
        `🌸 ${name}\n` +
        `🚶 Access: Near ${station} (${access})\n` +
        `✨ Sakura's Pick: ${vibe}\n` +
        `📍 Let's go!: ${mapUrl}\n\n`;
    });

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

/* ------------------------ Helpers ------------------------ */

function parseStationGenre(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();

  if (cleaned.includes(",")) {
    const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
    const station = parts[0] || cleaned;
    const genre = parts.slice(1).join(" ") || "restaurants";
    return { station, genre };
  }

  const parts = cleaned.split(" ");
  if (parts.length === 1) return { station: parts[0], genre: "restaurants" };

  const station = parts[0];
  const genre = parts.slice(1).join(" ").trim() || "restaurants";
  return { station, genre };
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
    rating: p.rating,
    user_ratings_total: p.user_ratings_total,
    geometry: p.geometry, // { location: { lat, lng } }
  }));
}

// ★ place_id を使わず、緯度経度でピンを刺す
function makeLatLngMapUrl(placeLoc, fallbackName, station) {
  if (placeLoc && typeof placeLoc.lat === "number" && typeof placeLoc.lng === "number") {
    // これが一番確実：その座標にピンが刺さる
    return `https://www.google.com/maps/search/?api=1&query=${placeLoc.lat},${placeLoc.lng}`;
  }
  // 万一座標が無い時だけ保険
  const q = `${fallbackName} ${station}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
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
