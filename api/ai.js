import { randomUUID } from "node:crypto";
import { admin } from "./_lib/supabase.js";
import { requireUser, clientIp } from "./_lib/auth.js";
import { ACTIONS, BadPayload } from "./_lib/actions.js";
import { callAnthropic, costMicros } from "./_lib/anthropic.js";
import { checkRate, checkKillSwitch, recordSpend, reserve, refund, logUsage } from "./_lib/meter.js";

/* Replaces api/claude.js. DELETE THAT FILE. An open proxy left at an old route
   is still an open proxy, and it is still your credit card. */

const CREDIT_MICROS = 2500;   // one credit buys $0.0025 (~0.24 rupees) of model spend

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const t0 = Date.now();
  const reqId = randomUUID();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── 1. who are you ────────────────────────────────────────────
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error).json({ error: auth.message });
  const { user, account } = auth;

  // ── 2. is the shop open ───────────────────────────────────────
  // First, because it is the cheapest way to say no, and on the day it fires
  // you want it to fire before you spend anything else.
  const ks = await checkKillSwitch();
  if (!ks.ok) {
    console.error(`KILL SWITCH TRIPPED: spent ${ks.spent} of ${ks.cap} micros today`);
    return res.status(503).json({
      error: "AI features are paused for maintenance. Your work is saved. Try again shortly.",
      code: "capacity",
    });
  }

  // ── 3. are you hammering ──────────────────────────────────────
  const rate = await checkRate(user.id);
  if (!rate.ok) {
    res.setHeader("Retry-After", rate.retryAfter);
    return res.status(429).json({
      error: "That's a lot of requests very quickly. Give it a moment.",
      code: "rate_limited", bucket: rate.bucket,
    });
  }

  // ── 4. is this a real action ──────────────────────────────────
  const { action, payload } = req.body || {};
  const spec = ACTIONS[action];
  if (!spec) return res.status(400).json({ error: "Unknown action.", code: "bad_action" });

  let built;
  try {
    built = spec.build(payload || {});
  } catch (e) {
    if (e instanceof BadPayload) return res.status(400).json({ error: e.message, code: "bad_payload" });
    throw e;
  }

  // ── 5. upload quota (separate from credits, because bytes are separate) ──
  if (spec.counts_upload) {
    const { data: bumped } = await admin
      .from("accounts")
      .update({ uploads_used: account.uploads_used + 1 })
      .eq("id", user.id)
      .lt("uploads_used", account.uploads_limit)   // the check and the write, one statement
      .select("uploads_used")
      .maybeSingle();
    if (!bumped) {
      return res.status(402).json({
        error: `You've used all ${account.uploads_limit} of your uploads.`,
        code: "upload_limit", upgrade: true,
      });
    }
  }

  // ── 6. take the money ─────────────────────────────────────────
  const held = spec.reserve;
  const spend = await reserve(user.id, action, held, reqId);
  if (!spend?.ok) {
    if (spec.counts_upload) {
      await admin.rpc("refund_uploads", { p_user: user.id, p_n: 1 }).catch(() => {});
    }
    const msg = {
      insufficient_credits: `Not enough credits. This needs up to ${held}; you have ${spend?.remaining ?? 0}.`,
      expired: "Your plan has expired. Top up to keep using AI features.",
      blocked: "This account is suspended.",
      no_account: "No account found.",
    }[spend?.reason] || "Could not authorise this request.";
    return res.status(402).json({ error: msg, code: spend?.reason, remaining: spend?.remaining, upgrade: true });
  }

  // ── 7. do the actual work ─────────────────────────────────────
  let out;
  try {
    out = await callAnthropic({
      model: spec.model,
      max_tokens: spec.max_tokens,
      system: built.system,
      messages: built.messages,
      cache_system: spec.cache_system,
    });
  } catch (err) {
    await refund(user.id, held, "settle_refund:network", reqId);
    await logUsage({ user_id: user.id, action, model: spec.model, status: 502,
                     duration_ms: Date.now() - t0, ip: clientIp(req) });
    return res.status(502).json({ error: "The model is unreachable right now. Nothing was charged." });
  }

  // Their error, not the user's. Give the credits back.
  if (!out.ok) {
    await refund(user.id, held, `settle_refund:upstream_${out.status}`, reqId);
    await logUsage({ user_id: user.id, action, model: spec.model, status: out.status,
                     duration_ms: Date.now() - t0, ip: clientIp(req) });
    const overloaded = out.status === 429 || out.status === 529;
    return res.status(overloaded ? 503 : 502).json({
      error: overloaded
        ? "The model is busy. Try again in a few seconds. Nothing was charged."
        : "That request failed. Nothing was charged.",
    });
  }

  // ── 8. settle: refund the gap between worst case and what it really cost ──
  const usage = out.body?.usage || {};
  const micros = costMicros(spec.model, usage);
  const actual = Math.max(1, Math.min(held, Math.ceil(micros / CREDIT_MICROS)));
  const back = held - actual;
  if (back > 0) await refund(user.id, back, "settle_refund", reqId);
  await recordSpend(micros);

  await logUsage({
    user_id: user.id, action, model: spec.model,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_write_tokens: usage.cache_creation_input_tokens || 0,
    cost_micros: micros, credits_charged: actual, status: 200,
    duration_ms: Date.now() - t0, ip: clientIp(req),
  });

  const remaining = (spend.remaining ?? 0) + back;
  res.setHeader("X-Credits-Remaining", String(remaining));

  /* Return the Anthropic response shape unchanged, so the existing parsing in
     CVBuilder.jsx (j?.content.filter(c => c.type === "text")) keeps working.
     Only `credits` is added. Small mercy: 6 call sites, one less thing to edit. */
  return res.status(200).json({ ...out.body, credits: { charged: actual, remaining } });
}
