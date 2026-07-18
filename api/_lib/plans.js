/* One definition of what money buys, imported by the checkout endpoint, the
   webhook, and the pricing page. If the price lives in three files it will be
   wrong in two of them by next month. */

export const PLANS = {
  pro: {
    id: "pro",
    name: "Pro",
    amount_paise: 18900,      // Razorpay talks in paise. 18900 = 189 rupees.
    display: "\u20B9189",
    credits: 250,
    uploads: 20,
    valid_days: 30,
  },
};

export const FREE = { credits: 15, uploads: 1 };

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
