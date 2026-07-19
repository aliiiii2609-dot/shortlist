import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/session.js";
import { installCloudStore, migrateGuestData } from "./lib/cloudStore.js";
import Auth from "./Auth.jsx";
import Pricing from "./Pricing.jsx";
import CVBuilder from "./CVBuilder.jsx";

/* The real front door.

   Everything account-related lives here, OUTSIDE the 8000-line CVBuilder, so
   the app itself did not have to be rewritten to become account-aware:

   - No session             -> the login screen, and the app never mounts.
   - Session, still loading  -> nothing (avoids a flash of the wrong screen).
   - Session, ready          -> CVBuilder, full screen. Sign-out and account
     info live in CVBuilder's own avatar chip (top right of the editor
     toolbar) via window.__signOut below; there is no separate overlay bar
     on top of the app for this to fight with.

   Before CVBuilder mounts we do two things that make it a real product:
     1. installCloudStore(userId) swaps window.storage for a Postgres-backed
        store, so every CV autosaves to the account and follows the user across
        devices instead of being trapped in one browser.
     2. seedProfile writes the signed-in identity into the store, so the app's
        own legacy welcome/sign-up screen finds a profile and never shows. That
        dead screen is neutralised without surgery inside the big component. */

function profileFromUser(user) {
  const meta = user.user_metadata || {};
  const name =
    meta.full_name || meta.name ||
    (user.email ? user.email.split("@")[0].replace(/[._]/g, " ") : "there");
  return {
    name,
    email: user.email || meta.email || "",
    provider: (user.app_metadata && user.app_metadata.provider) || "email",
    created: Date.now(),
  };
}

async function prepareStore(user) {
  installCloudStore(user.id);
  await migrateGuestData();                       // lift any pre-login guest CVs in
  const existing = await window.storage.get("inkwell-profile-v1").catch(() => null);
  if (!existing) {
    await window.storage.set("inkwell-profile-v1", JSON.stringify(profileFromUser(user)));
  }
}

export default function Gate() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [ready, setReady] = useState(false);         // store prepared for this user
  const [showPricing, setShowPricing] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) setReady(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let alive = true;
    if (session) {
      prepareStore(session.user).then(() => { if (alive) setReady(true); });
    }
    return () => { alive = false; };
  }, [session && session.user && session.user.id]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    window.location.assign(window.location.pathname);
  }, []);
  // CVBuilder's own account-avatar dropdown calls this directly; that's the
  // only sign-out entry point in the app now, so it has to stay global.
  useEffect(() => { window.__signOut = signOut; return () => { delete window.__signOut; }; }, [signOut]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("paid")) {
      setShowPricing(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const open = () => setShowPricing(true);
    window.addEventListener("shortlist:paywall", open);
    return () => window.removeEventListener("shortlist:paywall", open);
  }, []);

  if (session === undefined) return null;
  if (!session) return <Auth onDone={() => {}} />;
  if (!ready) return null;
  if (showPricing) return <Pricing onClose={() => setShowPricing(false)} />;

  return <CVBuilder />;
}
