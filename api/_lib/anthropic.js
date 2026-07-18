/* Prices in USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
   (checked 17 Jul 2026). Because a price is "$X per million tokens", cost in
   USD-millionths ("micros") is simply tokens * X. No floats, no rounding drift.
   Money in floats is how you end up 0.3 paise off and unable to reconcile. */
const PRICES = {
  "claude-haiku-4-5":  { in: 1,  out: 5,  cache_write: 1.25, cache_read: 0.10 },
  "claude-sonnet-4-6": { in: 3,  out: 15, cache_write: 3.75, cache_read: 0.30 },
  "claude-sonnet-5":   { in: 2,  out: 10, cache_write: 2.50, cache_read: 0.20 }, // intro rate to 31 Aug 2026, then 3/15
  "claude-opus-4-8":   { in: 5,  out: 25, cache_write: 6.25, cache_read: 0.50 },
};

export function priceOf(model) {
  return PRICES[model] || PRICES["claude-sonnet-4-6"];
}

export function costMicros(model, usage) {
  const p = priceOf(model);
  return Math.round(
    (usage.input_tokens || 0) * p.in +
    (usage.output_tokens || 0) * p.out +
    (usage.cache_creation_input_tokens || 0) * p.cache_write +
    (usage.cache_read_input_tokens || 0) * p.cache_read
  );
}

export async function callAnthropic({ model, max_tokens, system, messages, cache_system }) {
  /* cache_control on the system block: the first call pays 1.25x to write the
     cache, every call within 5 minutes pays 0.1x to read it. Scribe's system
     prompt is ~1600 identical tokens on every call, so this pays for itself on
     the second call and then keeps paying. Only worth it for prompts that are
     both large and byte-identical every time; do not sprinkle it everywhere. */
  const sys = cache_system && system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens, system: sys, messages }),
  });

  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body };
}
