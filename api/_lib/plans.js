/* One definition of what money buys, imported by the checkout endpoints, the
   webhook, and the pricing page. If the price lives in three files it will be
   wrong in two of them by next month.

   Two tiers, both billed as one-time 30-day packs (see valid_days) rather
   than true recurring subscriptions — Razorpay subscriptions are a separate
   API with mandates and auto-debit setup, a materially bigger build than
   restyling a price list, so "monthly" here means the cadence a user repeats
   the purchase at, same mechanism the app already had proven working.

   Shot: the editor alone, no model access, so credits is 0 on purpose —
   there is nothing in this plan that ever calls the AI endpoint.
   Sureshot: everything Shot has, plus the credit-metered AI features. */
export const PLANS = {
  shot: {
    id: "shot",
    name: "Shortlist Shot",
    amount_paise: 10900,      // Razorpay talks in paise. 10900 = 109 rupees.
    display: "₹109",
    credits: 0,
    uploads: 5,
    valid_days: 30,
  },
  sureshot: {
    id: "sureshot",
    name: "Shortlist Sureshot",
    amount_paise: 18900,      // 18900 = 189 rupees.
    display: "₹189",
    credits: 250,
    uploads: 20,
    valid_days: 30,
  },
};

/* No free tier: a brand-new account starts at 0 credits and 0 uploads and
   must buy a pack before either the editor's paid actions or the AI
   features unlock. Kept next to PLANS, not hardcoded at the signup trigger,
   for the same reason prices live here: one number, one place. */
export const FREE = { credits: 0, uploads: 0 };

/* What a credit buys, for the pricing page copy. Kept next to the plan so the
   marketing number and the metering number cannot drift apart. */
export const ACTION_PRICES = [
  { key: "rewrite",      label: "Rewrite a bullet",        credits: 1  },
  { key: "scribe",       label: "Scribe design command",   credits: 2  },
  { key: "steal_look",   label: "Copy the look from a PDF", credits: 4  },
  { key: "import",       label: "Smart Import a CV",       credits: 8  },
  { key: "cover_letter", label: "Draft a cover letter",    credits: 9  },
  { key: "tailor",       label: "Tailor to a job ad",      credits: 10 },
];
