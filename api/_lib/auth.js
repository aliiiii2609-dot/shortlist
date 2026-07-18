import { admin } from "./supabase.js";

/* Verify the caller. The JWT is signed by Supabase; the browser cannot forge
   one. getUser() costs a round trip (~30ms) and is the boring correct choice
   at your scale. If you ever need it faster, verify the signature locally
   with `jose` and the project JWT secret, and skip the round trip. Do not
   optimise this until a trace tells you to. */
export async function requireUser(req) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return { error: 401, message: "Sign in to use AI features." };

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { error: 401, message: "Your session expired. Sign in again." };

  const { data: acct } = await admin.from("accounts").select("*").eq("id", data.user.id).single();
  if (!acct) return { error: 403, message: "No account found." };
  if (acct.blocked) return { error: 403, message: acct.blocked_reason || "Account suspended." };

  return { user: data.user, account: acct };
}

export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
}
