import { supabase } from "./session.js";

/* Makes the CV builder account-bound and cross-device WITHOUT touching the
   8000-line component.

   CVBuilder persists everything through `window.storage`, an async
   get/set/delete/list contract. It does not care what is behind that contract.
   So we put Postgres behind it. Same four methods, same shapes, so every
   autosave, every load, every "delete my data" now goes to the user's own
   rows in public.user_state instead of this one browser's localStorage.

   Two design choices worth stating:

   1. Local cache, cloud truth. Every value is mirrored into localStorage under
      a per-user prefix. Reads answer from cache instantly (the app boots with
      no network wait and keeps working offline), then refresh from cloud in
      the background. Writes go to cache synchronously and to cloud in the
      background. The user never watches a spinner to see their own CV.

   2. Isolation is the database's job, not ours. Every row is stamped with the
      user id and RLS refuses cross-user access. Even if this file had a bug,
      the anon key + the user's JWT cannot read another account's rows. The
      per-user localStorage prefix is only so two people on one shared laptop
      do not see each other's cached copy; the real fence is server-side. */

let USER = null;
let PFX = null;

const cacheGet = (k) => {
  try { const s = localStorage.getItem(PFX + k); return s === null ? null : s; }
  catch { return null; }
};
const cacheSet = (k, s) => { try { localStorage.setItem(PFX + k, s); } catch {} };
const cacheDel = (k) => { try { localStorage.removeItem(PFX + k); } catch {} };

async function cloudGet(k) {
  const { data, error } = await supabase
    .from("user_state").select("v").eq("user_id", USER).eq("k", k).maybeSingle();
  if (error || !data) return null;
  // v is jsonb; the app stored a JSON string, so it round-trips as a string.
  return typeof data.v === "string" ? data.v : JSON.stringify(data.v);
}

async function cloudSet(k, s) {
  // Store the raw string as a jsonb string value. upsert = last write wins,
  // which matches the single-user-many-tabs reality of this app.
  const { error } = await supabase
    .from("user_state").upsert({ user_id: USER, k, v: s }, { onConflict: "user_id,k" });
  return !error;
}

async function cloudDel(k) {
  await supabase.from("user_state").delete().eq("user_id", USER).eq("k", k);
}

async function cloudList(prefix) {
  const { data, error } = await supabase
    .from("user_state").select("k").eq("user_id", USER).like("k", prefix + "%");
  if (error || !data) return [];
  return data.map((r) => r.k);
}

/* Install the cloud-backed store as window.storage. Called by Gate.jsx BEFORE
   CVBuilder mounts, so CVBuilder's own localStorage shim (which only installs
   `if (!window.storage)`) never runs. */
export function installCloudStore(userId) {
  USER = userId;
  PFX = `sl:${userId}:`;

  window.storage = {
    async get(key) {
      const cached = cacheGet(key);
      if (cached !== null) {
        // Return cache now; refresh from cloud in the background so another
        // device's newer write lands on next read.
        cloudGet(key).then((fresh) => { if (fresh !== null && fresh !== cached) cacheSet(key, fresh); }, () => {});
        return { key, value: cached, shared: false };
      }
      const fresh = await cloudGet(key);
      if (fresh !== null) cacheSet(key, fresh);
      return fresh === null ? null : { key, value: fresh, shared: false };
    },
    async set(key, value) {
      const s = String(value);
      cacheSet(key, s);                    // instant, never blocks the UI
      const ok = await cloudSet(key, s);   // durable, cross-device
      return ok ? { key, value: s, shared: false } : null;
    },
    async delete(key) {
      cacheDel(key);
      await cloudDel(key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = await cloudList(prefix);
      return { keys, prefix, shared: false };
    },
  };
}

/* One-time migration: if this browser has CVs from before login (made in guest
   mode under the old "shortlist:" localStorage prefix), lift them into the
   signed-in account the first time we see it, so nobody loses the resume they
   were mid-way through when the wall went up. Runs once per account per
   browser. */
export async function migrateGuestData() {
  const FLAG = PFX + "__migrated";
  try { if (localStorage.getItem(FLAG)) return; } catch { return; }

  const OLD = "shortlist:";
  const lifts = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (full && full.startsWith(OLD) && !full.startsWith(PFX)) {
        lifts.push([full.slice(OLD.length), localStorage.getItem(full)]);
      }
    }
  } catch { return; }

  for (const [k, v] of lifts) {
    // Do not clobber cloud data that already exists for this account.
    const existing = await cloudGet(k).catch(() => null);
    if (existing === null && v != null) { cacheSet(k, v); await cloudSet(k, v).catch(() => {}); }
  }
  try { localStorage.setItem(FLAG, "1"); } catch {}
}
