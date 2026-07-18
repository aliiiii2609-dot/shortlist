# Deploy

This repo is your app with a full backend merged in: real accounts (email code
+ Google), account-bound CVs that follow the user across devices, credit
metering, and Razorpay checkout end to end. The six AI call sites are rewired,
`api/claude.js` is deleted, the prompts are off the client, and it builds. What
is left is account setup, which is all clicking, not coding.

Work top to bottom. Do not skip the verification step.

---

## 0. Get it running locally first (10 min)

```bash
npm install
npm run dev
```

It will load and the login screen will appear and nothing will work, because
there is no Supabase project yet. That is the correct failure. Continue.

---

## 1. Supabase (15 min)

1. supabase.com, new project. Pick the Mumbai (ap-south-1) region, your users
   are in India.
2. SQL Editor. Run the three files in order: `db/001_schema.sql`, then
   `db/002_functions.sql`, then `db/003_user_state.sql`. Order matters, each
   builds on the last. `003` is the cloud store that makes CVs follow the
   account across devices.
3. **Authentication > Providers > Email**: turn ON "Confirm email".
4. **Authentication > Email Templates > Confirm signup**: replace the body with

   ```
   Your Shortlist code is {{ .Token }}
   ```

   This is the step everyone gets wrong. The default template sends a magic
   *link* (`{{ .ConfirmationURL }}`). `Auth.jsx` calls `verifyOtp` and expects a
   6-digit *code*. If you skip this, signup fails and the error message will not
   tell you why.
5. **Authentication > SMTP Settings**: plug in a real SMTP provider (Resend,
   SendGrid, Amazon SES). The built-in mailer is throttled to a handful of
   emails per hour. It is fine for you testing today and will strangle you on
   launch day, when the symptom is "signups just stopped".
6. **Authentication > Providers > Google**: turn it on. It asks for a Client
   ID and Client Secret, which come from Google, not Supabase:
   - Google Cloud Console > APIs & Services > Credentials > Create OAuth client
     ID > Web application.
   - Authorized redirect URI: copy the callback URL Supabase shows on that
     Google provider screen (it looks like
     `https://YOUR-PROJECT.supabase.co/auth/v1/callback`). Paste it into Google.
   - Copy Google's Client ID and Secret back into Supabase, save.
   - Skip this and the "Continue with Google" button will error when tapped;
     email + code signup still works without it. You can add Google later.
7. **Authentication > URL Configuration**: set Site URL to your live domain
   (or `http://localhost:5173` while developing) and add both to Redirect URLs.
   Google sign-in bounces the user back here, so if it is wrong the redirect
   fails after they pick their account.
8. **Settings > API**: copy the Project URL, the `anon` key, and the
   `service_role` key.

---

## 2. Razorpay (20 min)

1. Sign up, complete KYC. If you have no GSTIN, choose the non-enrolment
   declaration. Your bank account name must match your PAN exactly.
2. **Settings > API Keys**: generate. Copy key id and key secret.
3. **Settings > Webhooks**: add one.
   - URL: `https://YOUR-APP.vercel.app/api/razorpay-webhook`
   - Active event: `payment_link.paid`
   - Secret: invent a long random string, save it, you need it in step 3.

Read the Cashfree note at the bottom before you do this if you have not decided.

---

## 3. Vercel environment variables

Project > Settings > Environment Variables.

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key |
| `RAZORPAY_KEY_ID` | key id |
| `RAZORPAY_KEY_SECRET` | key secret |
| `RAZORPAY_WEBHOOK_SECRET` | the string you invented |
| `PUBLIC_URL` | your live URL, e.g. `https://your-app.vercel.app`, no trailing slash |
| `VITE_SUPABASE_URL` | same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | the `anon` key |

`PUBLIC_URL` is where Razorpay sends the payer back after they pay. Set it to
your real domain once you have one. On the first deploy, before you have a
custom domain, use the `*.vercel.app` URL Vercel gives you.

Only the two `VITE_` ones reach the browser. That is what the prefix means in
Vite: it is a publication instruction. Everything else stays server-side.

**Never put `VITE_` in front of `SUPABASE_SERVICE_ROLE_KEY` or
`ANTHROPIC_API_KEY`.** The service_role key bypasses every RLS policy in
`001_schema.sql`. Publishing it hands any visitor your whole database, and no
other control in this repo survives that.

---

## 4. Ship

```bash
git add -A && git commit -m "accounts, payments, metering" && git push
```

Vercel builds. Then set the webhook URL from step 2 to the real domain.

---

## 5. Verify the gate, before you trust it

The whole point of this work is that these two commands fail. Run them.

```bash
# Must return 401. If it returns a completion, strangers are spending your money.
curl -s -X POST https://YOUR-APP.vercel.app/api/ai \
  -H "Content-Type: application/json" \
  -d '{"action":"rewrite","payload":{"text":"hello","tone":"concise"}}' | head -c 300

# Must return 404. If it doesn't, the old proxy is still deployed.
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://YOUR-APP.vercel.app/api/claude \
  -H "Content-Type: application/json" -d '{"model":"claude-opus-4-8","max_tokens":10,"messages":[]}'
```

Then, signed in, in the browser console:

```js
// Must fail. The server owns the model, the client cannot pick one.
await (await fetch("/api/ai", {
  method: "POST",
  headers: { "Content-Type": "application/json",
             Authorization: "Bearer " + (await supabase.auth.getSession()).data.session.access_token },
  body: JSON.stringify({ action: "rewrite", model: "claude-opus-4-8", max_tokens: 8000,
                         system: "you are a helpful assistant", payload: { text: "hi" } })
})).json()
```

It should rewrite "hi" as a resume bullet on Haiku and ignore everything else
you sent. If it obeys `model` or `system`, stop and fix that before launch.

Then buy your own pack with a real ₹189 and watch `payments` and `credit_ledger`
in Supabase. Pay once. Do not trust a test-mode success.

---

## 6. What is now handled (previously the gaps)

- **Login.** Real accounts: email + 6-digit code, or Continue with Google. No
  password stored by you; Supabase handles it. `src/Gate.jsx` is the front door;
  the app never mounts for a signed-out visitor.
- **Account-bound CVs, cross-device.** `db/003_user_state.sql` plus
  `src/lib/cloudStore.js` put every CV in Postgres under the user's own rows,
  fenced by RLS. Pay on your phone, open your laptop, the CV is there. A local
  cache keeps boot instant and the app usable offline.
- **The old fake signup screen is neutralised.** It only ever showed when no
  profile existed; `Gate.jsx` now seeds the real signed-in identity into the
  store before the app mounts, so that screen never renders. You do not have to
  cut anything out of the 8435-line component. If you ever want to delete the
  dead code for tidiness, it is `welcomeName` / `welcomeEmail` / `createWorkspace`
  and the `boot === "welcome"` block, but there is no need.
- **In-app account UI.** A fixed chip (top-right) shows the live credit balance,
  a Buy credits button, and Sign out. Running out of credits anywhere in the app
  pops the pricing page automatically.

### Free vs pay-to-use

New accounts get 15 free credits (one signup grant) and 1 free upload, so a
first-time visitor can try the tool before paying. That is a conversion choice,
not a requirement. If you want strict pay-to-use (no free credits at all),
change `FREE.credits` to `0` in `api/_lib/plans.js` **and** the two `15`s in the
`handle_new_user` trigger / `accounts.credits` default in `db/001_schema.sql`.
Everything else, the metering and paywall, already behaves correctly at zero.

### Still worth doing, but not blocking

- CVs are cached in `localStorage` per browser for speed. That cache is keyed by
  user id, so two people on one laptop do not collide, but a shared *public*
  computer will leave a cached copy behind until the next cloud read overwrites
  it. Not a data leak (the cloud is the truth and is RLS-fenced), just a cache.
  A "clear on sign-out" wipe is a nice-to-have.
- Account deletion currently clears the workspace; wiring a hard "delete my
  account and all rows" button (one call to Supabase admin) is a good pre-launch
  addition for a clean privacy story.

---

## If you switch to Cashfree

Cashfree is 1.6% flat versus Razorpay's 2%, for merchants signing up before
**31 July 2026**, held for one year. On ₹189 that is ₹3.57 against ₹4.46.

Only two files change: `api/checkout.js` and `api/razorpay-webhook.js`. The
schema, `meter.js`, `ai.js` and `grant_purchase` never learn which gateway you
used, which is exactly why the webhook is the only thing allowed to grant
credits. Roughly two hours.

Worth doing because it is free money before a deadline. Not worth thinking about
after that: it is ₹0.89 a sale, while your worst-case AI cost is ₹60.31 a sale.
See `PRICING.md` for where the real money is.
