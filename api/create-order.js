import { requireUser } from "./_lib/auth.js";
import { PLANS } from "./_lib/plans.js";

/* Standard Checkout's order-creation endpoint. This exists alongside
   checkout.js (Payment Links), not instead of it: same product, same
   attribution trick, different Razorpay object so the in-page modal has
   something to open.

   The important part is what this does NOT do: it does not grant credits,
   and it does not need to. An Order that gets paid fires the exact same
   payment.captured webhook that Payment Links already fire, straight into
   the existing handler in razorpay-webhook.js. That handler is still the
   only code path that ever calls grant_purchase. Nothing changes there. */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error).json({ error: auth.message });
  const { user } = auth;

  const plan = PLANS.pro;
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) return res.status(500).json({ error: "Payments are not configured." });

  // Defensive floor, not a real limit at this app's one price point: Razorpay
  // itself rejects anything under 100 paise, so fail with a clear message
  // before it ever reaches their API.
  if (plan.amount_paise < 100) {
    return res.status(500).json({ error: "Configured plan amount is below Razorpay's minimum." });
  }

  let r;
  try {
    r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64"),
      },
      body: JSON.stringify({
        amount: plan.amount_paise,
        currency: "INR",
        receipt: `${plan.id}_${user.id}_${Date.now()}`,
        notes: { user_id: user.id, plan: plan.id, credits: String(plan.credits) },
      }),
    });
  } catch (e) {
    console.error("razorpay order network error", e);
    return res.status(502).json({ error: "Could not reach Razorpay. Try again." });
  }

  const body = await r.json().catch(() => ({}));

  if (r.status === 401) {
    console.error("razorpay auth failed \u2014 check RAZORPAY_KEY_ID/SECRET");
    return res.status(401).json({ error: "Payments are misconfigured." });
  }
  if (!r.ok) {
    console.error("razorpay order create failed", body);
    return res.status(500).json({ error: "Could not start checkout. Try again." });
  }

  return res.status(200).json({
    order_id: body.id,
    amount: body.amount,
    currency: body.currency,
    key_id: key,   // safe to return: this is the public half, same value a VITE_var would ship
    plan: { name: plan.name, credits: plan.credits },
    user: { name: user.user_metadata?.name || "", email: user.email || "" },
  });
}
