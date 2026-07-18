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
