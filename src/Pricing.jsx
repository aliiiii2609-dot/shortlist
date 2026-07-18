import React, { useEffect, useState } from "react";
import { fetchMe, startOrderCheckout } from "./lib/session.js";

/* Uses the app's existing light tokens (line 5338 of CVBuilder.jsx) so it does
   not look bolted on. Everything shown here comes from /api/me, which reads
   api/_lib/plans.js. The prices on this page cannot drift from the prices the
   metering charges, because they are the same object. */

const PAPER = "#EEF0F6", INK = "#171A23", INK2 = "#555B6B", MUTE = "#949AAA",
      HAIR = "#EAECF2", HAIR2 = "#DCE0EA";

const wrap = { minHeight: "100vh", background: PAPER, padding: "44px 20px",
               fontFamily: "'Inter',system-ui,-apple-system,sans-serif", color: INK };
const grid = { maxWidth: 760, margin: "0 auto", display: "grid", gap: 16,
               gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" };
const card = { background: "#fff", border: `1px solid ${HAIR2}`, borderRadius: 14, padding: 24 };
const cta = { width: "100%", marginTop: 18, background: INK, color: "#fff", border: "none",
              borderRadius: 10, padding: "12px 16px", fontSize: 13.5, fontWeight: 700,
              cursor: "pointer", fontFamily: "inherit" };
const ghost = { ...cta, background: "#fff", color: INK2, border: `1px solid ${HAIR2}`, fontWeight: 600 };

const Row = ({ children }) => (
  <div style={{ display: "flex", gap: 9, alignItems: "baseline", fontSize: 13, color: INK2,
                lineHeight: 1.6, marginBottom: 7 }}>
    <span style={{ color: INK, fontWeight: 700 }}>{"\u00B7"}</span><span>{children}</span>
  </div>
);

export default function Pricing({ onClose }) {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { fetchMe().then(setMe); }, []);

  /* The webhook is what grants the credits, and it lands a second or two
     after Razorpay confirms the payment, so a single fetch right after
     checkout often shows the OLD balance and the user thinks it failed.
     Poll briefly instead of trusting either the redirect or the modal. Used
     both for the old "returned from a Payment Link" path (?paid=1) and for
     the new in-page modal path, so there is exactly one polling loop. */
  const pollForUpgrade = () => {
    let n = 0;
    const t = setInterval(async () => {
      const m = await fetchMe();
      if (m) setMe(m);
      if (m?.plan === "pro" || ++n > 10) clearInterval(t);
    }, 1500);
  };

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("paid")) return;
    pollForUpgrade();
  }, []);

  const buy = async () => {
    setErr(""); setBusy(true);
    try {
      await startOrderCheckout();
      pollForUpgrade();
    } catch (e) {
      // A closed modal isn't a failure worth alarming over; anything else is.
      if (!e.dismissed) setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!me) return <div style={{ ...wrap, display: "grid", placeItems: "center", color: MUTE }}>Loading\u2026</div>;

  const pack = me.pack;

  return (
    <div style={wrap}>
      <div style={{ maxWidth: 760, margin: "0 auto 26px" }}>
        <h1 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.6px", margin: "0 0 6px" }}>Pricing</h1>
        <p style={{ color: INK2, fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          Everything except the AI is free and always will be. The editor, the templates, the PDF export,
          every Scribe design command that runs locally. You only spend credits when a request actually
          reaches the model.
        </p>
        {err && <div style={{ color: "#B91C1C", fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      </div>

      <div style={grid}>
        {/* Free */}
        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: MUTE, textTransform: "uppercase",
                        letterSpacing: 1.2, marginBottom: 8 }}>Free</div>
          <div style={{ fontSize: 33, fontWeight: 700, letterSpacing: "-1px", marginBottom: 14 }}>
            {"\u20B9"}0
          </div>
          <Row><strong>{me.free.credits} credits</strong> once, on signup</Row>
          <Row><strong>{me.free.uploads} upload</strong></Row>
          <Row>Full editor, templates and PDF export</Row>
          <Row>Offline Scribe commands, unlimited</Row>
          <button style={ghost} disabled>{me.plan === "free" ? "Your current plan" : "Included"}</button>
        </div>

        {/* Pro */}
        <div style={{ ...card, border: `1.5px solid ${INK}`, position: "relative" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase",
                        letterSpacing: 1.2, marginBottom: 8 }}>Pro</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 14 }}>
            <span style={{ fontSize: 33, fontWeight: 700, letterSpacing: "-1px" }}>{pack.display}</span>
            <span style={{ fontSize: 13, color: MUTE }}>one time</span>
          </div>
          <Row><strong>{pack.credits} credits</strong></Row>
          <Row><strong>{pack.uploads} uploads</strong> (CVs, PDFs, screenshots)</Row>
          <Row>Valid <strong>{pack.valid_days} days</strong></Row>
          <Row>Packs stack: buy two, get {pack.credits * 2} credits and {pack.valid_days * 2} days</Row>
          <button style={{ ...cta, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={buy}>
            {busy ? "Opening checkout\u2026" : me.plan === "pro" ? "Add another pack" : `Get Pro for ${pack.display}`}
          </button>
          <div style={{ fontSize: 10.5, color: MUTE, textAlign: "center", marginTop: 9 }}>
            UPI, cards and net banking via Razorpay
          </div>
        </div>
      </div>

      {/* What a credit buys. Being specific here is worth more than a big number:
          "250 credits" means nothing on its own, and a vague "messages" count is
          the thing people feel cheated by later. */}
      <div style={{ maxWidth: 760, margin: "26px auto 0", ...card }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>What a credit buys</div>
        <div style={{ fontSize: 12.5, color: INK2, marginBottom: 16, lineHeight: 1.6 }}>
          Typical cost per action. Short inputs cost less, and we refund the difference automatically,
          so these are a ceiling in practice rather than a flat fee.
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {me.prices.map((p) => (
              <tr key={p.key} style={{ borderTop: `1px solid ${HAIR}` }}>
                <td style={{ padding: "9px 0", color: INK2 }}>{p.label}</td>
                <td style={{ padding: "9px 0", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>
                  {p.credits} {p.credits === 1 ? "credit" : "credits"}
                </td>
                <td style={{ padding: "9px 0 9px 16px", textAlign: "right", color: MUTE, whiteSpace: "nowrap" }}>
                  ~{Math.floor(pack.credits / p.credits)} per pack
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 11.5, color: MUTE, marginTop: 14, lineHeight: 1.6 }}>
          A realistic pack: import your old CV, tailor it to eight job ads, draft four cover letters,
          and still have credits left for around forty bullet rewrites.
        </div>
      </div>

      {/* Balance */}
      <div style={{ maxWidth: 760, margin: "16px auto 0", ...card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 13, color: INK2 }}>{me.email}</div>
            <div style={{ fontSize: 12, color: MUTE, marginTop: 3 }}>
              {me.credits} credits {"\u00B7"} {me.uploads.limit - me.uploads.used} uploads left
              {me.expires_at && ` \u00B7 ${me.expired ? "expired" : "renews"} ${new Date(me.expires_at).toLocaleDateString()}`}
            </div>
          </div>
          {onClose && <button style={{ ...ghost, width: "auto", marginTop: 0, padding: "9px 18px" }} onClick={onClose}>
            Back to editor
          </button>}
        </div>
      </div>
    </div>
  );
}
