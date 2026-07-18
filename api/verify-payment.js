import crypto from "node:crypto";
import { requireUser } from "./_lib/auth.js";

/* Checks the modal's own claim, for the UI only. This is deliberately NOT
   the thing that grants credits \u2014 see razorpay-webhook.js for why nothing
   the browser reports is ever trusted with money. A signature check here
   only proves the payment succeeded to Razorpay's own math; it does not
   prove this request wasn't replayed, and unlike the webhook it isn't
   delivered server-to-server. So: verify it, tell the user "you're paid,
   crediting your account now", and then do exactly nothing to their
   balance. The webhook, which fires independently and is usually a couple
   of seconds behind this response at most, is what actually updates it.
   Pricing.jsx already polls /api/me after a purchase for exactly this gap. */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireUser(req);
  if (auth.error) return res.status(auth.error).json({ error: auth.message });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment fields." });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(500).json({ error: "Payments are not configured." });

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  // timingSafeEqual, matching razorpay-webhook.js: a plain === leaks the
  // correct signature one byte at a time through response timing.
  const sigBuf = Buffer.from(razorpay_signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  const ok = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!ok) {
    console.warn("verify-payment: signature mismatch", { razorpay_order_id, razorpay_payment_id });
    return res.status(400).json({ verified: false, error: "Signature does not match." });
  }

  return res.status(200).json({
    verified: true,
    message: "Payment confirmed. Crediting your account now \u2014 this usually takes a few seconds.",
  });
}
