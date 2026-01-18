require("dotenv").config();

async function fuelixChat({ messages, model }) {
  const baseUrl = process.env.FUELIX_API_URL || "https://api.fuelix.ai";
  const apiKey = process.env.FUELIX_API_KEY;
  const m = model || process.env.FUELIX_MODEL || "gpt-5.2";

  if (!apiKey) throw new Error("Missing FUELIX_API_KEY in .env");

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: m,
      messages,
      temperature: 0.2,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Fuel iX error HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  return content || "";
}

module.exports = { fuelixChat };
