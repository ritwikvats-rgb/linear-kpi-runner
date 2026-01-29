require("dotenv").config();

// Timeout wrapper for fetch
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Simple retry logic
async function withRetry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) throw e;
      // Only retry on network/timeout errors, not API errors
      if (e.name === 'AbortError' || e.message.includes('fetch')) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

async function fuelixChat({ messages, model, temperature = 0.2, timeout = 30000 }) {
  const baseUrl = process.env.FUELIX_API_URL || "https://api.fuelix.ai";
  const apiKey = process.env.FUELIX_API_KEY;
  const m = model || process.env.FUELIX_MODEL || "gpt-5.2";

  if (!apiKey) throw new Error("Missing FUELIX_API_KEY in .env");

  return withRetry(async () => {
    const res = await fetchWithTimeout(
      `${baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: m,
          messages,
          temperature,
        }),
      },
      timeout
    );

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Fuel iX error HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }

    const content = json?.choices?.[0]?.message?.content;
    return content || "";
  });
}

module.exports = { fuelixChat };
