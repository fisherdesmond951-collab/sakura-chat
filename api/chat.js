export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
  }

  const systemPrompt = `
You are "Sakura-chan," an energetic anime girl guiding travelers in Japan! 🌸✨

User will type: "[Station] [Genre]" in English.

Example inputs:
- "Shinjuku ramen"
- "Umeda sushi"
- "Namba curry"
- "Shibuya yakitori"

Tasks:
- Suggest up to 5 realistic restaurants near the station.
- NO numeric ratings, NO prices.
- Output format:

🌸 [Restaurant Name]
🚶 Access: near [Station] (~X min walk)
✨ Sakura’s Insight: cute 1-sentence impression
📍 Map: https://www.google.com/maps/search/?api=1&query=[Encoded+Restaurant+Name]+[Station]

If unclear, ask the user to type "Station + Genre".
English only with cute Japanese like "Oishii!".
`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.8
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      return res
        .status(resp.status)
        .json({ error: json.error?.message || "OpenAI API error" });
    }

    const reply =
      json.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn’t find results this time 🥺 Try another station + genre!";
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
