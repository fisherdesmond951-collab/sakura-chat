// api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { text } = req.body || {};
    const query = (text || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Empty input" });
    }

    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // ===== 1) Google Places (New) Text Search =====
    const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.editorialSummary"
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

    // ===== 2) 店名を ASCII のみ にする（ローマ字化） =====
    const namesForRomanize = places.map((p) => p.displayName.text);

    const romanizePrompt = `
Convert each restaurant name to ASCII (English letters/numbers/punctuation) only.
- No Japanese characters.
- If it has an official English name, use it; otherwise use clear Hepburn-style romanization.
Return JSON array of strings ONLY.

Names:
${JSON.stringify(namesForRomanize)}
`.trim();

    const romanizeRes = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const romanizeJson = await romanizeRes.json();
    const romanizedNames =
      safeJsonArray(romanizeJson?.choices?.[0]?.message?.content) || namesForRomanize;

    // ===== 3) マップURL + seedテキスト =====
    const items = places.map((p, i) => {
      const nameEn = romanizedNames[i] || p.displayName.text;

      // ✅ 英語UI寄せのマップURL（ブラウザならかなり英語になる）
      const mapsUrl =
        `https://www.google.com/maps/search/?api=1` +
        `&query=${encodeURIComponent(nameEn)}` +
        `&query_place_id=${encodeURIComponent(p.id)}` +
        `&hl=en&gl=us`;

      const seed =
        p.editorialSummary?.text ||
        `A popular local restaurant in Japan. Address: ${p.formattedAddress || "Japan"}.`;

      return { nameEn, mapsUrl, seed };
    });

    // ===== 4) 口コミ 2〜3 文で詳細めに =====
    const insightPrompt = `
You are Sakura-chan 🌸✨

Write 5 entries.
Rules:
- English only
- Cute, friendly travel-guide tone for foreign visitors
- Restaurant name is already ASCII (do not change it)
- For each shop, write 2–3 sentences (about 35–55 words total)
- Include atmosphere, food style, and why it's nice for travelers
- Include the Google Maps URL exactly as provided

Format:

🌸 {NAME}
✨ Sakura's Insight: {2–3 sentences}
📍 {URL}

Data:
${items
  .map(
    (it) =>
      `NAME=${it.nameEn}\nSEED=${it.seed}\nURL=${it.mapsUrl}`
  )
  .join("\n\n")}
`.trim();

    const insightRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ role: "user", content: insightPrompt }],
      }),
    });

    const insightJson = await insightRes.json();
    const reply =
      insightJson?.choices?.[0]?.message?.content?.trim() ||
      items
        .map(
          (it) =>
            `🌸 ${it.nameEn}\n✨ Sakura's Insight: A tasty place loved by locals and visitors alike! 🌸\n📍 ${it.mapsUrl}`
        )
        .join("\n\n");

    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}

// --- helper ---
function safeJsonArray(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}
