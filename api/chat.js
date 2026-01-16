export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { text } = req.body || {};
    const query = (text || "").trim();
    if (!query) return res.status(400).json({ error: "Empty input" });

    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Places API (New) Text Search
    const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.rating",
          "places.userRatingCount",
          "places.editorialSummary",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: "en",
        regionCode: "JP",
        maxResultCount: 10,
      }),
    });

    const placesJson = await placesRes.json();
    if (!placesRes.ok) {
      return res.status(500).json({ error: placesJson?.error?.message || "Places API error" });
    }

    const places = (placesJson.places || [])
      .filter((p) => p?.id && p?.displayName?.text)
      .slice(0, 5);

    if (places.length === 0) {
      return res.json({
        reply:
          "Konnichiwa! I couldn't find good matches this time 🥺\nTry a simpler input like: Shinjuku ramen / Shibuya sushi 🌸",
      });
    }

    // Romanize names to ASCII-only
    const namesForRomanize = places.map((p) => p.displayName.text);

    const romanizePrompt = `
Convert each restaurant name to ASCII (English letters/numbers/punctuation) only.
- No Japanese characters.
- If it has an official English name, use it; otherwise use clear Hepburn-style romanization.
Return JSON array of strings ONLY.

Names:
${JSON.stringify(namesForRomanize)}
`.trim();

    const romanize = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "You output strictly valid JSON only." },
          { role: "user", content: romanizePrompt },
        ],
      }),
    });

    const romanizeJson = await romanize.json();
    const romanizedNames = safeJsonArray(romanizeJson?.choices?.[0]?.message?.content) || namesForRomanize;

    const items = places.map((p, i) => {
      const nameEn = romanizedNames[i] || p.displayName.text;

      // ✅ place_id を “query_place_id” で渡す（これが一番確実）
      const mapsUrl =
        `https://www.google.com/maps/search/?api=1` +
        `&query=${encodeURIComponent(nameEn)}` +
        `&query_place_id=${encodeURIComponent(p.id)}` +
        `&hl=en`;

      const seedText =
        p.editorialSummary?.text ||
        `A popular spot in Japan. Address: ${p.formattedAddress || "Japan"}.`;

      return { nameEn, mapsUrl, seedText };
    });

    const insightPrompt = `
You are Sakura-chan, cute and friendly. Write 5 entries.
Rules:
- English only, cute tone with emojis 🌸✨
- Restaurant name MUST be ASCII only (already provided).
- 1 short "Sakura Insight" sentence each (not too long).
- Include the Google Maps URL exactly as provided.
Format each entry exactly:

🌸 {NAME}
✨ Sakura's Insight: {ONE SENTENCE}
📍 {URL}

Data:
${items
  .map((it, idx) => `${idx + 1}) NAME=${it.nameEn}\nSEED=${it.seedText}\nURL=${it.mapsUrl}\n`)
  .join("\n")}
`.trim();

    const insight = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: "You follow formatting rules strictly." },
          { role: "user", content: insightPrompt },
        ],
      }),
    });

    const insightJson = await insight.json();
    const reply =
      insightJson?.choices?.[0]?.message?.content?.trim() ||
      items.map((it) => `🌸 ${it.nameEn}\n✨ Sakura's Insight: So yummy! 🌸\n📍 ${it.mapsUrl}`).join("\n\n");

    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}

function safeJsonArray(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {}
  return null;
}
