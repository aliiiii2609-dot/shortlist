# Shortlist: accounts, payments, metering

## What changes

| Before | After |
|---|---|
| `localStorage` "sign-up", no check | Supabase account, emailed code, password |
| `/api/claude` open to the world | `/api/ai`, JWT required, credits charged |
| Client sends `model` + `system` + `max_tokens` | Client sends `{ action, payload }`. Server owns the rest. |
| No limits | Credits, uploads, rate limits, global daily cap |
| No payments | Razorpay link per user, webhook grants credits |
| No idea what anything costs | `usage_events`: real tokens, real cost, per call |

**Delete `api/claude.js` when `/api/ai` is live.** An old open route is still an open route.

---

## 1. Supabase

Create a project (free tier: 50k monthly active users, so 2000 is nothing).

1. **SQL Editor** → run `db/001_schema.sql`, then `db/002_functions.sql`.
2. **Authentication → Emails → Confirm signup**: replace the body with the code, not a link:
   ```html
   <p>Your Shortlist code is <strong>{{ .Token }}</strong></p>
   <p>It expires in an hour.</p>
   ```
   Miss this and users get a magic link, no code ever arrives, and the code box looks broken. This is the single most common way this flow gets shipped wrong.
3. **Authentication → Providers → Email**: turn "Confirm email" ON. Off means anyone can register `ceo@google.com` and burn its free credits.
4. **Rate limits**: the default outbound email limit is a few per hour, which will silently throttle your signups on day one. Plug in a real SMTP provider (Resend, SES, Postmark) under **Project Settings → Auth → SMTP** before you launch.

## 2. Razorpay

1. Dashboard → **Settings → API Keys** → generate.
2. Dashboard → **Settings → Webhooks → Add**:
   - URL: `https://<your-app>.vercel.app/api/razorpay-webhook`
   - Secret: a long random string (this is `RAZORPAY_WEBHOOK_SECRET`, and it is not your API secret)
   - Events: `payment_link.paid`, `payment.captured`
3. Test in **Test Mode** first. Razorpay's dashboard has a "Send test webhook" button; use it before touching real money.

## 3. Vercel environment variables

**Settings → Environment Variables**, then redeploy (they bake in at build time).

| Name | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | already set |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret.** Bypasses RLS. |
| `RAZORPAY_KEY_ID` | |
| `RAZORPAY_KEY_SECRET` | |
| `RAZORPAY_WEBHOOK_SECRET` | the one you invented above |
| `PUBLIC_URL` | `https://<your-app>.vercel.app` |
| `VITE_SUPABASE_URL` | same value as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | the anon key. Public by design. |

> **Vite inlines every `VITE_*` variable into the client bundle.** A variable named `VITE_SUPABASE_SERVICE_ROLE_KEY` would be published to the entire internet on your next deploy and it would look completely innocent in the diff. The service role key has no `VITE_` prefix for that reason. Do not add one.

```bash
npm i @supabase/supabase-js
```

## 4. Copy files in

```
db/001_schema.sql          db/002_functions.sql
api/ai.js                  api/checkout.js
api/me.js                  api/razorpay-webhook.js
api/_lib/*.js
src/Auth.jsx               src/Pricing.jsx           src/lib/session.js
```

---

## 5. The six call sites in `CVBuilder.jsx`

This is the real work. Every one follows the same shape: delete the request body, name an action.

```js
import { aiCall, AICallError } from "./lib/session.js";
```

### `aiRewrite` (~line 4159)
```diff
-const res = await fetch(AI_ENDPOINT, {
-  method:"POST", headers:{ "Content-Type":"application/json" },
-  body: JSON.stringify({
-    model:"claude-sonnet-4-6", max_tokens:1000,
-    system:`You are an elite resume writer. Rewrite ... more ${design.tone} ...`,
-    messages:[{ role:"user", content: orig }],
-  }),
-});
-const j = await res.json();
+const j = await aiCall("rewrite", { text: orig, tone: design.tone });
 const t = (j?.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
```

### `runImport` (~line 4214)
```diff
-body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:1000, system: importSystem(), messages:[{ role:"user", content }] }),
+const j = await aiCall("import", { content, draft: importDraft, style: importStyle });
```
`importSystem()` moves to the server. Delete it, and delete `IMPORT_SCHEMA` / `STYLE_SCHEMA` / `STYLE_RULES` from the component.

### `stealLook` (~line 4338)
```diff
+const j = await aiCall("steal_look", { content });
```

### `draftCover` (~line 4365)
```diff
+const j = await aiCall("cover_letter", { resume: resumeText, jd });
```

### `aiScribe` (~line 4779)
```diff
+const j = await aiCall("scribe", { state: buildSnapshot(), recent, instruction: msg });
```
Delete `CMD_SYS` from the component (~6.4 KB, and it is now on the server where it is also prompt-cached).

### `runTailor` (~line 4929)
```diff
+const j = await aiCall("tailor", { jd: jdt, bullets: lines.join("\n"), skills: skillLine });
```
Delete `TAILOR_SYS`.

**Deleting the prompt constants is not tidying.** While the browser can still send a `system` field, a paying user can point your key at anything they like, and your bill stops being a function of what your product does.

### Error handling, once, everywhere

The existing `catch { say("AI is unreachable...") }` will now swallow "you're out of credits" and tell people the network is down. Use:

```js
catch (e) {
  if (e instanceof AICallError && e.upgrade) { setShowPricing(true); say(e.message); }
  else say(e.message || "AI is unreachable here.");
}
```

### Response shape

`/api/ai` returns the Anthropic body unchanged plus `credits: { charged, remaining }`, so all six `j?.content.filter(...)` lines keep working untouched. Use `j.credits.remaining` to update the header chip.

## 6. Gate the app

```jsx
const [session, setSession] = useState(undefined);   // undefined = still checking
useEffect(() => {
  supabase.auth.getSession().then(({ data }) => setSession(data.session));
  const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
  return () => sub.subscription.unsubscribe();
}, []);

if (session === undefined) return null;              // avoid flashing the login screen
if (!session) return <Auth onDone={() => {}} />;     // onAuthStateChange handles the rest
```

Delete the old `welcomeEmail` / `welcomeName` / `createWorkspace` block (~line 3928 and ~7726).

**Storage.** CVs still live in `localStorage`, so they are per-device and do not follow the account. That is a real gap now that people are paying. Namespace keys by `session.user.id` at minimum, so two people on one laptop do not see each other's CVs. Syncing them to Postgres is the right fix and is a separate job.

---

## 7. Test the gate before you trust it

```bash
# must be 401. If this returns a completion, you are still paying for strangers.
curl -X POST https://your-app.vercel.app/api/ai \
  -H 'Content-Type: application/json' \
  -d '{"action":"rewrite","payload":{"text":"hi"}}'

# must be 404. If it is not, you forgot to delete it.
curl -X POST https://your-app.vercel.app/api/claude \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-4-8","max_tokens":4000,"messages":[{"role":"user","content":"hi"}]}'
```

Then, signed in: spend to zero and confirm 402. Fire 30 rewrites in a loop and confirm 429. Set `daily_cap_micros` to 1 and confirm 503.

---

## Answering "how do I limit 2000 users"

Six layers. Each one catches what the layer above cannot.

**1. Identity.** No valid JWT, no call. Every request is attributable to a row in `accounts`.

**2. Entitlement.** `spend_credits` refuses if `blocked`, or if `plan_expires_at` has passed.

**3. Quota (credits).** Your exact billing control. The critical detail is that it is **one SQL statement**:

```sql
update accounts set credits = credits - p_cost
 where id = p_user and credits >= p_cost
```

The obvious version reads the balance, checks it in JS, then writes. Two tabs, two clicks at the same moment: both read 5, both pass the check, both write `5 - 8`. At 2000 users someone finds that by accident within a week. Putting the check in the `WHERE` clause makes Postgres re-evaluate it under a row lock, and the second update simply matches nothing.

**4. Rate limits.** 20/min, 200/hour, 800/day per user. Not billing (credits are billing); this stops one user from opening 500 sockets and taking your Anthropic org rate limit down for everybody else.

**5. Global kill switch.** A daily cap in USD-millionths across all users. Layers 1 to 4 protect you from a bad *user*. This protects you from a bad *deploy*: a retry loop or a runaway `useEffect` hits every user at once and no per-user limit will notice. Start at $3/day. This is the layer that lets you sleep.

**6. Server-owned prompts and models.** No request the client can construct costs more than the caps in `_lib/actions.js`. The client cannot pick Opus. It cannot ask for 8k output tokens. It cannot send its own system prompt.

### Does this hold at 2000 users?

Comfortably, and it is worth being concrete about why. 2000 users × 250 credits, spent over a month, is roughly 60k API calls, about 1.5 requests/minute at a flat rate. Postgres will not notice. Every hot path is a single indexed statement.

The parts that actually bite first, in the order they will bite:

- **Your Anthropic org rate limit**, not your database. Concurrency spikes hit that ceiling long before Postgres breathes hard. Watch for 429s from upstream (`ai.js` already turns them into a polite 503 and refunds).
- **Supabase auth emails.** Default limits are a handful per hour. Real SMTP before launch.
- **`rate_counters` growth.** Cron `gc_rate_counters()` daily.
- **`getUser()` on every call**, one round trip (~30ms). Only worth replacing with local `jose` verification when a trace says so.

### Free-tier abuse

15 free credits × unlimited throwaway Gmail addresses is a real hole, and it is the one that will actually cost you money. In rough order of value:

1. Block disposable domains at signup (a Supabase auth hook against a public list).
2. Log `signup_ip`. More than ~3 accounts from one IP in a day is not a family.
3. Cut free credits to whatever proves the product works and no further. 15 is a guess. `usage_events` will tell you the real number within a fortnight.
4. Do not add device fingerprinting until 1 to 3 are done and still failing. It is a lot of work, it breaks for honest people, and it is easy to defeat.

### What to actually watch, week one

```sql
-- what is your bill made of, per action
select action, count(*), sum(cost_micros)/1e6 as usd,
       round(avg(cost_micros)) as avg_micros, sum(credits_charged) as credits
from usage_events where created_at > now() - interval '7 days'
group by action order by usd desc;

-- who is unusually expensive (before they become a story)
select user_id, count(*), sum(cost_micros)/1e6 as usd
from usage_events where created_at > now() - interval '1 day'
group by user_id order by usd desc limit 20;

-- is prompt caching actually working (cache_read should dwarf cache_write)
select action, sum(cache_read_tokens) reads, sum(cache_write_tokens) writes
from usage_events where created_at > now() - interval '1 day' group by action;

-- gross margin, for real
select sum(amount_paise)/100.0 as revenue_inr,
       (select sum(cost_micros)/1e6*96.5 from usage_events) as ai_cost_inr
from payments where status = 'captured';
```

Set a **billing alert in the Anthropic console** as well. The kill switch depends on your own code being correct; the console alert does not.
