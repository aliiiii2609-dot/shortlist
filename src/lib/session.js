import { createClient } from "@supabase/supabase-js";

/* Only the anon key ships to the browser. It is designed to be public: it can
   do nothing except what RLS allows, which (per 001_schema.sql) is "read your
   own row". The service_role key must never appear in any VITE_* variable. */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Google sign-in redirects back with ?code=...; detectSessionInUrl lets
      // the client finish the exchange automatically. flowType pkce is the
      // secure OAuth flow for a browser app with no server secret. Neither
      // touches our own ?paid=1 (Razorpay) or ?reset=1 params.
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  }
);

export class AICallError extends Error {
  constructor(message, { code, status, remaining, upgrade } = {}) {
    super(message);
    this.code = code; this.status = status;
    this.remaining = remaining; this.upgrade = !!upgrade;
  }
}

/* THE ONLY WAY THE APP TALKS TO THE MODEL.

   Replaces every `fetch(AI_ENDPOINT, { body: { model, system, messages } })`
   in CVBuilder.jsx. The client now names an action and hands over data. It
   cannot choose the model, the prompt, or max_tokens, because those are not
   its business and were never safe to trust.

   Returns the Anthropic response body unchanged, so existing parsing
   (j?.content.filter(c => c.type === "text")) keeps working as-is. */
export async function aiCall(action, payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new AICallError("Sign in to use AI features.", { code: "no_session", status: 401 });

  const res = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, payload }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Out of credits (or expired plan): surface the pricing page from wherever
    // in the app the call was made, without editing each of the six catch
    // blocks. Gate listens for this and opens checkout.
    if (res.status === 402 || body.upgrade) {
      try { window.dispatchEvent(new CustomEvent("shortlist:paywall", { detail: body })); } catch {}
    }
    throw new AICallError(body.error || "That request failed.", {
      code: body.code, status: res.status, remaining: body.remaining, upgrade: body.upgrade,
    });
  }
  // Let the account chip refresh its balance after any successful spend.
  try { window.dispatchEvent(new CustomEvent("shortlist:spent", { detail: body.credits })); } catch {}
  return body;   // { ...anthropic response, credits: { charged, remaining } }
}

export async function fetchMe() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${session.access_token}` } });
  return res.ok ? res.json() : null;
}

export async function startCheckout() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in first.");
  const res = await fetch("/api/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not start checkout.");
  return body.url;
}

/* Loads checkout.js once and caches the promise, same pattern CVBuilder.jsx
   already uses for mammoth/pdf.js, so re-opening the modal never re-fetches
   the script. */
let _razorpayScript = null;
function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  if (_razorpayScript) return _razorpayScript;
  _razorpayScript = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => { _razorpayScript = null; reject(new Error("Could not load Razorpay. Check your connection.")); };
    document.head.appendChild(s);
  });
  return _razorpayScript;
}

/* Standard Checkout: an in-page modal instead of a redirect to a hosted
   Payment Link page. Resolves once the signature is verified (see
   verify-payment.js for exactly what that does and does not prove); the
   actual credit grant still lands a moment later via the webhook, same as
   the Payment Link flow already assumes in Pricing.jsx's polling.
   planId is "shot" or "sureshot" — see api/_lib/plans.js. */
export async function startOrderCheckout(planId) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in first.");

  const orderRes = await fetch("/api/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ plan: planId }),
  });
  const order = await orderRes.json();
  if (!orderRes.ok) throw new Error(order.error || "Could not start checkout.");

  await loadRazorpayScript();

  return new Promise((resolve, reject) => {
    const rz = new window.Razorpay({
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: "Shortlist",
      description: order.plan.credits > 0 ? `${order.plan.name} \u2014 ${order.plan.credits} credits` : order.plan.name,
      prefill: { name: order.user.name, email: order.user.email },
      theme: { color: "#191713" },
      handler: async (resp) => {
        try {
          const vRes = await fetch("/api/verify-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            }),
          });
          const v = await vRes.json();
          if (!vRes.ok || !v.verified) throw new Error(v.error || "Could not verify payment.");
          resolve(v);
        } catch (e) { reject(e); }
      },
      modal: {
        // Closed without paying \u2014 not really an error, just not a success.
        ondismiss: () => reject(Object.assign(new Error("Checkout closed."), { dismissed: true })),
      },
    });
    rz.on("payment.failed", (resp) => {
      reject(new Error(resp.error?.description || "Payment failed. No charge was made."));
    });
    rz.open();
  });
}
