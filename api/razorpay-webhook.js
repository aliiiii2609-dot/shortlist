import crypto from "node:crypto";
import { admin } from "./_lib/supabase.js";
import { PLANS } from "./_lib/plans.js";

/* THE ONLY CODE PATH THAT GRANTS CREDITS.

   Nothing on the frontend, and nothing in checkout.js, may ever add a credit.
   Not "the user got redirected to the success page". Not "the popup returned
   ok". Those are claims made by a browser, and a browser is a thing an
   attacker controls. This handler is the only place that believes anything
   about money, and it only believes what is HMAC-signed by Razorpay.

   Setup: Razorpay Dashboard -> Settings -> Webhooks -> Add
     URL:     https://your-app.vercel.app/api/razorpay-webhook
     Secret:  a long random string -> also set as RAZORPAY_WEBHOOK_SECRET
     Events:  payment_link.paid, payment.captured
*/

/* Vercel parses JSON bodies by default. That reserialises the payload, and the
   reserialised bytes are not the bytes Razorpay signed, so every signature
   check fails with a body that looks perfectly correct. This one line is
   responsible for a large share of the "my webhook signature is invalid"
   questions on the internet. */
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const raw = await rawBody(req);
  const sig = req.headers["x-razorpay-signature"] || "";

  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  // timingSafeEqual, not ===. String compare leaks the signature one byte at a
  // time through response timing. It is a real attack and the fix is free.
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn("razorpay webhook: bad signature");
    return res.status(400).json({ error: "invalid signature" });
  }

  let evt;
  try { evt = JSON.parse(raw.toString("utf8")); }
  catch { return res.status(400).json({ error: "bad json" }); }

  const type = evt.event;
  if (type !== "payment_link.paid" && type !== "payment.captured") {
    return res.status(200).json({ ok: true, ignored: type });   // 200 or Razorpay retries forever
  }

  const payment = evt.payload?.payment?.entity;
  const link = evt.payload?.payment_link?.entity;
  if (!payment?.id) return res.status(200).json({ ok: true, ignored: "no payment entity" });

  const notes = { ...(link?.notes || {}), ...(payment?.notes || {}) };
  let userId = notes.user_id || null;
  const email = (payment.email || link?.customer?.email || "").toLowerCase();

  /* Fallback for links you created by hand in the dashboard before wiring
     checkout.js up. Email matching is genuinely unreliable and that is why
     checkout.js exists, but leaving a paying customer stranded is worse than
     a fuzzy match, so: try it, and log loudly when it is what saved us. */
  if (!userId && email) {
    const { data } = await admin.from("accounts").select("id").eq("email", email).maybeSingle();
    if (data) { userId = data.id; console.warn(`webhook: matched ${email} by email, no user_id in notes`); }
  }

  if (!userId) {
    /* Someone paid and we cannot tell who. Do not drop it on the floor: bank
       it unattributed, 200 so Razorpay stops retrying, and go look. This row
       is the difference between "we refunded them in 10 minutes" and "we have
       no idea, sorry". */
    await admin.from("payments").insert({
      razorpay_payment_id: payment.id, razorpay_link_id: link?.id ?? null,
      email, amount_paise: payment.amount, status: "unattributed", raw: evt,
    }).then(() => {}, () => {});
    console.error(`UNATTRIBUTED PAYMENT ${payment.id} from ${email || "unknown"}`);
    return res.status(200).json({ ok: true, unattributed: true });
  }

  const plan = PLANS[notes.plan] || PLANS.pro;

  /* Trust the amount Razorpay reports, never the amount in notes. A payment
     link's amount is fixed at creation, but partial payments exist, and this
     is the number that actually hit your account. */
  if (payment.amount < plan.amount_paise) {
    console.warn(`partial payment ${payment.id}: ${payment.amount} of ${plan.amount_paise}`);
    return res.status(200).json({ ok: true, ignored: "underpaid" });
  }

  const { data, error } = await admin.rpc("grant_purchase", {
    p_payment_id: payment.id,
    p_link_id: link?.id ?? null,
    p_user: userId,
    p_email: email,
    p_amount_paise: payment.amount,
    p_credits: plan.credits,
    p_uploads: plan.uploads,
    p_valid_days: plan.valid_days,
    p_raw: evt,
  });

  if (error) {
    console.error("grant_purchase failed", error);
    // 500 on purpose: Razorpay retries, and grant_purchase is idempotent, so a
    // retry is safe and is exactly what we want after a transient DB blip.
    return res.status(500).json({ error: "grant failed" });
  }

  const row = Array.isArray(data) ? data[0] : data;
  console.log(`payment ${payment.id}: user ${userId} granted=${row?.granted} balance=${row?.credits}`);
  return res.status(200).json({ ok: true });
}
