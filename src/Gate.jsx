import React, { useState, useEffect, useCallback } from "react";
import { supabase, fetchMe } from "./lib/session.js";
import { installCloudStore, migrateGuestData } from "./lib/cloudStore.js";
import Auth from "./Auth.jsx";
import Pricing from "./Pricing.jsx";
import CVBuilder from "./CVBuilder.jsx";

/* The real front door.

   Everything account-related lives here, OUTSIDE the 8000-line CVBuilder, so
   the app itself did not have to be rewritten to become account-aware:

   - No session             -> the login screen, and the app never mounts.
   - Session, still loading  -> nothing (avoids a flash of the wrong screen).
   - Session, ready          -> CVBuilder, with a thin account bar on top.

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

  return (
    <>
      <AccountBar onUpgrade={() => setShowPricing(true)} onSignOut={signOut} />
      <CVBuilder />
    </>
  );
}

/* A slim always-visible chip: balance, buy, sign out. A fixed overlay rather
   than an edit to CVBuilder's header, so it cannot break the app's layout. */
function AccountBar({ onUpgrade, onSignOut }) {
  const [me, setMe] = useState(null);
  const load = useCallback(() => { fetchMe().then(setMe); }, []);

  useEffect(() => {
    load();
    const onSpent = () => load();
    window.addEventListener("shortlist:spent", onSpent);
    window.addEventListener("focus", onSpent);
    return () => {
      window.removeEventListener("shortlist:spent", onSpent);
      window.removeEventListener("focus", onSpent);
    };
  }, [load]);

  const credits = me ? me.credits : null;
  const low = credits !== null && credits <= 3;

  return (
    <div style={barWrap}>
      <div style={{ ...pill, ...(low ? pillLow : null) }} title="AI credits remaining">
        <span style={{ opacity: 0.7 }}>credits</span>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{credits === null ? "\u2026" : credits}</strong>
      </div>
      <button style={buyBtn} onClick={onUpgrade}>Buy credits</button>
      <button style={outBtn} onClick={onSignOut} title="Sign out">Sign out</button>
    </div>
  );
}

const barWrap = {
  position: "fixed", top: 10, right: 12, zIndex: 2147483000,
  display: "flex", alignItems: "center", gap: 8,
  fontFamily: "'Inter',system-ui,-apple-system,sans-serif",
};
const pill = {
  display: "flex", alignItems: "center", gap: 6, fontSize: 12,
  background: "rgba(20,18,28,.82)", color: "#F3F1FA", padding: "6px 11px",
  borderRadius: 999, border: "1px solid rgba(255,255,255,.14)", backdropFilter: "blur(8px)",
};
const pillLow = { background: "rgba(120,30,30,.9)", border: "1px solid rgba(255,140,140,.4)" };
const buyBtn = {
  fontSize: 12, fontWeight: 700, color: "#191713", background: "#F7F5EF",
  border: "none", borderRadius: 999, padding: "6px 13px", cursor: "pointer",
  fontFamily: "inherit", boxShadow: "0 6px 18px -8px rgba(0,0,0,.5)",
};
const outBtn = {
  fontSize: 12, color: "rgba(240,238,250,.85)", background: "rgba(20,18,28,.55)",
  border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, padding: "6px 11px",
  cursor: "pointer", fontFamily: "inherit",
};
