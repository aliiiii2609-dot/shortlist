import { admin } from "./supabase.js";

/* Per-user rate limits. These are NOT your billing control (credits are).
   They exist so one user cannot fire 500 concurrent requests, blow through a
   whole pack in four seconds, and take your Anthropic org rate limit down for
   everyone else while they do it.

   Tuned to be invisible to a human: nobody clicks Rewrite 20 times a minute.
   If your support inbox says otherwise, raise them; these numbers are a guess
   until you have a week of usage_events to look at. */
export const LIMITS = {
  min:  { seconds: 60,    max: 20  },
  hour: { seconds: 3600,  max: 200 },
  day:  { seconds: 86400, max: 800 },
};

export async function checkRate(userId) {
  for (const [bucket, cfg] of Object.entries(LIMITS)) {
    const { data, error } = await admin.rpc("bump_rate", {
      p_user: userId, p_bucket: bucket, p_window_seconds: cfg.seconds,
    });
    if (error) continue;               // never fail closed on a counter bug
    if (data > cfg.max) {
      return { ok: false, bucket, retryAfter: cfg.seconds };
    }
  }
  return { ok: true };
}

/* The global brake. Per-user limits protect you from one bad user; this
   protects you from one bad deploy. A retry loop or a runaway useEffect hits
   every user at once, and no per-user limit will catch it. */
export async function checkKillSwitch() {
  const { data, error } = await admin.rpc("check_kill_switch");
  if (error) return { ok: true };      // do not take the product down over a metrics bug
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: row?.ok !== false, spent: row?.spent, cap: row?.cap };
}

export async function recordSpend(micros) {
  if (micros > 0) await admin.rpc("record_spend", { p_micros: micros });
}

/* Charge first, reconcile after.
   Charging AFTER the call looks fairer and is wrong: it lets a user fire 100
   concurrent calls while holding 1 credit, because none of them have settled
   yet. Charge the full estimate up front, refund the difference once the real
   token count comes back, and refund everything if the call fails. */
export async function reserve(userId, action, cost, ref) {
  const { data, error } = await admin.rpc("spend_credits", {
    p_user: userId, p_cost: cost, p_action: action, p_ref: ref,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row;                          // { ok, remaining, reason }
}

export async function refund(userId, amount, reason, ref) {
  if (amount <= 0) return;
  await admin.rpc("refund_credits", {
    p_user: userId, p_amount: amount, p_reason: reason, p_ref: ref,
  });
}

export async function logUsage(row) {
  const { error } = await admin.from("usage_events").insert(row);
  if (error) console.error("usage_events insert failed", error.message);
  /* Deliberately not thrown. If logging breaks, the user still gets their
     answer. But watch this log: silent metering loss is how a bill surprises
     you at the end of the month. */
}
