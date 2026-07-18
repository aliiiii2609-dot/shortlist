import React, { useState } from "react";
import { supabase } from "./lib/session.js";

/* Replaces the welcome/sign-up screen around line 7726 of CVBuilder.jsx.
   Same visual language (dark panel, cream primary button); different in that
   it actually gates something.

   Flow:
     signup -> Supabase emails a 6-digit code -> verify -> session
     login  -> email + password -> session

   One Supabase setting is required and is easy to miss:
     Authentication -> Emails -> Confirm signup
   The default template contains a magic LINK. Replace its body with the code:
       <p>Your Shortlist code is <strong>{{ .Token }}</strong></p>
   Without this, users get a link, no code ever arrives, and the box below
   sits there looking broken. {{ .Token }} is the 6-digit code. */

const wrap = { minHeight: "100vh", display: "grid", placeItems: "center", background: "#14121C",
               fontFamily: "'Inter',system-ui,-apple-system,sans-serif", padding: 20 };
const card = { width: "100%", maxWidth: 380, background: "rgba(255,255,255,.05)",
               border: "1px solid rgba(255,255,255,.10)", borderRadius: 16, padding: "26px 24px",
               backdropFilter: "blur(20px)" };
const label = { display: "block", fontSize: 9.5, color: "rgba(228,224,250,.95)", marginBottom: 5,
                fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.4 };
const input = { width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.28)",
                border: "1px solid rgba(255,255,255,.16)", borderRadius: 9, padding: "11px 12px",
                fontSize: 13.5, color: "#F3F1FA", fontFamily: "inherit", outline: "none", marginBottom: 13 };
const primary = { width: "100%", background: "#F7F5EF", color: "#191713", border: "none", borderRadius: 10,
                  padding: "12px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                  fontFamily: "inherit", boxShadow: "0 10px 26px -12px rgba(0,0,0,.66)" };
const quiet = { width: "100%", marginTop: 9, background: "transparent", color: "#E7E3F6",
                border: "1px solid rgba(255,255,255,.22)", borderRadius: 10, padding: "10px 16px",
                fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" };
const errS = { fontSize: 11, color: "#FCA5A5", marginBottom: 10, lineHeight: 1.5 };
const noteS = { fontSize: 11.5, color: "rgba(216,211,240,.72)", lineHeight: 1.6, marginBottom: 15 };

const google = { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                 background: "#FFFFFF", color: "#1F1F1F", border: "none", borderRadius: 10,
                 padding: "11px 16px", fontSize: 13.5, fontWeight: 600, cursor: "pointer",
                 fontFamily: "inherit", marginBottom: 4 };
const divider = { display: "flex", alignItems: "center", textAlign: "center", margin: "14px 0 12px",
                  color: "rgba(216,211,240,.5)" };
const dividerText = { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 1, padding: "0 10px" };

// Google's brand mark, inline so there is no external asset to load or break.
const GIcon = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
);

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

export default function Auth({ onDone }) {
  const [mode, setMode] = useState("signup");        // signup | code | login | forgot
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setErr(""); setBusy(true);
    try { await fn(); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  const doSignup = () => run(async () => {
    if (!emailOk(email)) throw new Error("That doesn't look like a full email address.");
    // Enforced server-side by Supabase too; this is just a kinder message.
    if (pw.length < 8) throw new Error("Use at least 8 characters.");
    const { data, error } = await supabase.auth.signUp({ email: email.trim().toLowerCase(), password: pw });
    if (error) throw error;
    // If email confirmation is OFF in Supabase, signUp returns a live session and
    // the user is already signed in, so go straight into the app. If it is ON,
    // no session comes back yet and we fall through to the 6-digit code step.
    if (data && data.session) { onDone(); return; }
    setMode("code");
  });

  const doVerify = () => run(async () => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(), token: code.trim(), type: "signup",
    });
    if (error) throw new Error(
      /expired|invalid/i.test(error.message)
        ? "That code is wrong or has expired. Send a new one."
        : error.message
    );
    onDone();
  });

  const doLogin = () => run(async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(), password: pw,
    });
    /* Deliberately vague. "No account with that email" tells an attacker which
       addresses are registered here, which is free reconnaissance for credential
       stuffing. Say the same thing for a wrong password and an unknown user. */
    if (error) throw new Error("That email and password don't match.");
    onDone();
  });

  const doResend = () => run(async () => {
    const { error } = await supabase.auth.resend({ type: "signup", email: email.trim().toLowerCase() });
    if (error) throw error;
    setErr("New code sent.");
  });

  const doGoogle = () => run(async () => {
    // Redirects to Google, then back to the app. The session is established on
    // return by detectSessionInUrl (see session.js); onAuthStateChange in
    // Gate.jsx then swaps the login screen for the app. No code needed here
    // after the redirect fires.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  });

  const doForgot = () => run(async () => {
    if (!emailOk(email)) throw new Error("Enter your email first.");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/?reset=1`,
    });
    if (error) throw error;
    setErr("If that address has an account, a reset link is on its way.");
  });

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 21, fontWeight: 700, color: "#F7F5EF", marginBottom: 5, letterSpacing: "-.4px" }}>
          Shortlist
        </div>

        {mode === "signup" && (
          <>
            <div style={noteS}>Create an account. Your CVs autosave to it, so you can pick up on any device.</div>
            {err && <div style={errS}>{err}</div>}
            <button style={{ ...google, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={doGoogle}>
              <GIcon /> Continue with Google
            </button>
            <div style={divider}><span style={dividerText}>or with email</span></div>
            <span style={label}>Email</span>
            <input style={input} type="email" autoComplete="email" value={email}
                   onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            <span style={label}>Password</span>
            <input style={input} type="password" autoComplete="new-password" value={pw}
                   onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" />
            <button style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={doSignup}>
              {busy ? "Creating account\u2026" : "Create account"}
            </button>
            <button style={quiet} onClick={() => { setErr(""); setMode("login"); }}>I already have an account</button>
          </>
        )}

        {mode === "code" && (
          <>
            <div style={noteS}>We sent a 6-digit code to <strong style={{ color: "#F3F1FA" }}>{email}</strong>. It expires in an hour.</div>
            {err && <div style={errS}>{err}</div>}
            <span style={label}>Code</span>
            <input style={{ ...input, letterSpacing: 6, fontSize: 18, textAlign: "center" }}
                   inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                   onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
            <button style={{ ...primary, opacity: code.length === 6 && !busy ? 1 : 0.55 }}
                    disabled={code.length !== 6 || busy} onClick={doVerify}>
              {busy ? "Checking\u2026" : "Verify and continue"}
            </button>
            <button style={quiet} onClick={doResend}>Send another code</button>
            <button style={{ ...quiet, border: "none", marginTop: 4 }} onClick={() => setMode("signup")}>
              Use a different email
            </button>
          </>
        )}

        {mode === "login" && (
          <>
            <div style={noteS}>Welcome back.</div>
            {err && <div style={errS}>{err}</div>}
            <button style={{ ...google, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={doGoogle}>
              <GIcon /> Continue with Google
            </button>
            <div style={divider}><span style={dividerText}>or with email</span></div>
            <span style={label}>Email</span>
            <input style={input} type="email" autoComplete="email" value={email}
                   onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            <span style={label}>Password</span>
            <input style={input} type="password" autoComplete="current-password" value={pw}
                   onChange={(e) => setPw(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && doLogin()} />
            <button style={{ ...primary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={doLogin}>
              {busy ? "Signing in\u2026" : "Sign in"}
            </button>
            <button style={quiet} onClick={() => { setErr(""); setMode("signup"); }}>Create an account instead</button>
            <button style={{ ...quiet, border: "none", marginTop: 2, fontSize: 11.5, color: "rgba(216,211,240,.7)" }}
                    onClick={doForgot}>Forgot password</button>
          </>
        )}
      </div>
    </div>
  );
}
