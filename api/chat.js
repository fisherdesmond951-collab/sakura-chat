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

    // --- Places API (New) ---
    const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
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
      .filter(p => p?.id && p?.displayName?.text)
      .slice(0, 5);

    if (places.length === 0) {
      return res.json({
        reply: "Konnichiwa! I couldn't find good matches 🥺 Try something like Shinjuku ramen 🌸",
      });
    }

    // --- Romanize names ---
    const namesForRomanize = places.map(p => p.displayName.text);

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
          { role: "system", content: "Return JSON array only." },
          {
            role: "user",
            content: `Romanize to ASCII only:\n${JSON.stringify(namesForRomanize)}`,
          },
        ],
      }),
    });

    const romanizeJson = await romanize.json();
    const romanizedNames = safeJsonArray(romanizeJson?.choices?.[0]?.message?.content) || namesForRomanize;

    const items = places.map((p, i) => {
      const nameEn = romanizedNames[i] || p.displayName.text;
      const mapsUrl =
        `https://www.google.com/maps/search/?api=1` +
        `&query=${encodeURIComponent(nameEn)}` +
        `&query_place_id=${encodeURIComponent(p.id)}` +
        `&hl=en`;

      const seed = p.editorialSummary?.text || "A popular local restaurant in Japan.";

      return { nameEn, mapsUrl, seed };
    });

    // 🔽 ここが重要：長さを数値指定
    const insightPrompt = `
You are Sakura-chan 🌸✨

Write 5 entries.
Rules:
- English only
- Cute, friendly travel-guide tone
- Restaurant name is already ASCII
- Write **2–3 sentences per shop (about 35–55 words total)**
- Slightly detailed, but not long
- Include atmosphere, food style, and why it's nice for visitors
- Include the Google Maps URL exactly

Format:

🌸 {NAME}
✨ Sakura's Insight: {2–3 sentences}
📍 {URL}

Data:
${items.map(it =>
  `NAME=${it.nameEn}\nSEED=${it.seed}\nURL=${it.mapsUrl}`
).join("\n\n")}
`.trim();

    const insight = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7, // 少しだけ表現を広げる
        messages: [{ role: "user", content: insightPrompt }],
      }),
    });

    const insightJson = await insight.json();
    const reply = insightJson?.choices?.[0]?.message?.content?.trim();

    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

function safeJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}
