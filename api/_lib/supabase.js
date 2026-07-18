import { createClient } from "@supabase/supabase-js";

/* service_role bypasses RLS. It must NEVER reach the browser.
   Note the env var has no VITE_ prefix: Vite inlines every VITE_* var into
   the client bundle, so a VITE_SUPABASE_SERVICE_KEY would be published to
   the world on your next deploy. This is the single easiest way to lose
   your database, and it looks completely innocent in a diff. */
export const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
