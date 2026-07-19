import { requireUser } from "./_lib/auth.js";
import { ACTION_PRICES, PLANS, FREE } from "./_lib/plans.js";
import { admin } from "./_lib/supabase.js";

/* Account state for the header chip and the pricing page. The balance the UI
   shows is a display of the server's number, never a copy the client keeps. */
export default async function handler(req, res) {
  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error).json({ error: auth.message });
  const a = auth.account;

  const { data: recent } = await admin
    .from("credit_ledger").select("delta,reason,created_at,balance_after")
    .eq("user_id", a.id).order("created_at", { ascending: false }).limit(20);

  return res.status(200).json({
    email: a.email,
    plan: a.plan,
    credits: a.credits,
    uploads: { used: a.uploads_used, limit: a.uploads_limit },
    expires_at: a.plan_expires_at,
    expired: !!(a.plan_expires_at && new Date(a.plan_expires_at) < new Date()),
    prices: ACTION_PRICES,
    packs: PLANS,   // both tiers now, so the pricing page can render both cards
    free: FREE,
    ledger: recent || [],
  });
}
