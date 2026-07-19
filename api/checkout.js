import { requireUser } from "./_lib/auth.js";
import { PLANS } from "./_lib/plans.js";

/* You asked for "people who paid me at a separate link". This builds that
   link, but per user, at the moment they click Upgrade.

   The tempting version is one static Razorpay Payment Link you paste in a
   DM. Do not. A static link has no idea who paid, so the webhook can only
   match on the email the payer typed at checkout, and people type the wrong
   email constantly: a work address, a spouse's card, a typo. Every one of
   those is a support ticket where someone has paid you and cannot use the
   product, and you are reconciling by hand at 1am.

   A per-user link carries notes.user_id. The webhook reads it. Attribution is
   exact, and the payer cannot edit it. */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error).json({ error: auth.message });
  const { user } = auth;

  // Same plan-selection guard as create-order.js: two tiers now, so this
  // can no longer assume which one the button meant.
  const planId = String((req.body && req.body.plan) || "").trim();
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: "Unknown plan." });

  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) return res.status(500).json({ error: "Payments are not configured." });

  const r = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64"),
    },
    body: JSON.stringify({
      amount: plan.amount_paise,
      currency: "INR",
      description: `Shortlist ${plan.name}: ${plan.credits} credits, ${plan.uploads} uploads, ${plan.valid_days} days`,
      customer: { email: user.email },
      notify: { email: true, sms: false },
      reminder_enable: true,
      // This is the whole point. It survives the round trip and comes back
      // in the webhook, so attribution never depends on what the user typed.
      notes: { user_id: user.id, plan: plan.id, credits: String(plan.credits) },
      callback_url: `${process.env.PUBLIC_URL}/?paid=1`,
      callback_method: "get",
    }),
  });

  const body = await r.json();
  if (!r.ok) {
    console.error("razorpay payment_link failed", body);
    return res.status(502).json({ error: "Could not start checkout. Try again." });
  }

  /* Note what does NOT happen here: no credits are granted. The browser
     returning to callback_url proves nothing at all, and anyone can just
     visit /?paid=1 directly. Only the signed webhook grants credits. */
  return res.status(200).json({ url: body.short_url, id: body.id });
}
