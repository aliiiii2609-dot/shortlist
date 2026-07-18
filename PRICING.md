# Why ₹189 buys 250 credits

Rates checked 17 Jul 2026: [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing), Razorpay 2% + 18% GST, USD/INR ≈ 96.5.

## The money that reaches you

| | |
|---|---|
| Gross | ₹189.00 |
| Razorpay (2% + 18% GST on the fee = 2.36%) | −₹4.46 |
| **Net** | **₹184.54** (≈ $1.91) |

GST applies to the fee, not the cart. Note what is **not** in this table: your own GST liability once you cross the registration threshold, and income tax. ₹184.54 is not profit, it is revenue.

## What each action really costs

Measured from the actual prompts in `CVBuilder.jsx`, not guessed.

| Action | Model | Typical cost | Credits charged |
|---|---|---|---|
| Rewrite a bullet | Haiku 4.5 | ₹0.07 | 1 |
| Scribe command | Haiku 4.5 | ₹0.29 | 2 |
| Copy a look (vision) | Sonnet 4.6 | ₹0.80 | 4 |
| Smart Import | Sonnet 4.6 | ₹1.90 | 8 |
| Cover letter | Sonnet 4.6 | ₹2.04 | 9 |
| Tailor to a job ad | Sonnet 4.6 | ₹2.23 | 10 |

**1 credit = $0.0025 (≈ ₹0.24) of model spend** (`CREDIT_MICROS` in `api/ai.js`).

## Does the pack survive its worst case?

A user who burns all 250 credits costs you at most **₹60.31**, against ₹184.54 net. **Worst-case gross margin: 67%.** Not the average case: the floor. Most users will not finish the pack, and margin goes up from there.

## Reserve, then refund

Each action has two numbers. `reserve` is charged up front and assumes every payload cap is hit *and* the model emits `max_tokens`. `typical` is what settlement refunds down to.

Charging only after the call looks fairer and is wrong: it lets someone fire 100 concurrent calls holding 1 credit, because none have settled. So: hold the worst case, refund the difference the moment the real token count comes back, refund everything if the call fails. Tailor reserves 14 and typically charges 10.

## The two levers that matter

**Model routing.** The same ₹189 pack is worth wildly different amounts depending on which model serves it:

| Everything on | Actions per pack (65% margin) |
|---|---|
| Sonnet 4.6 | ~57 |
| Sonnet 5 (intro $2/$10) | ~86 |
| Haiku 4.5 | ~173 |

`actions.js` routes per action: Haiku for rewrite and Scribe (structured, high-frequency, cheap), Sonnet where prose quality is the product. **Test whether Haiku is good enough for `import` and `tailor` too.** If it is, your margin roughly doubles and nothing else in the system has to change. That is the highest-leverage hour of work available to you here.

**Prompt caching.** Scribe's `CMD_SYS` is ~1600 *identical* tokens on every call. Cache reads cost 0.1× input, so `cache_system: true` cuts Scribe roughly 40% and pays for itself on the second call within the 5-minute window. Only worth it for prompts that are both large and byte-identical; do not sprinkle it around.

**Sonnet 5 is $2/$10 until 31 Aug 2026, then $3/$15.** Your bill rises ~50% on 1 September if you move to it. Diarise that.

## Things this pricing does not survive

- **A user with 20 CVs.** Uploads are capped at 20 for a reason: a 6-page PDF is ~10k vision tokens on one call.
- **Refund abuse.** Someone spends 240 credits, then disputes the payment. You are out the AI cost *and* the chargeback fee. At ₹189 it is not worth automating; if it becomes a pattern, block on `lifetime_paise` and dispute count.
- **Being wrong about the mix.** Every number above rests on estimated action frequencies. `usage_events` replaces the estimate with fact inside two weeks. Re-run the margin query then, before you scale spend on ads.

## Open decision: one-time or subscription?

Built as a one-time pack, because that is what "paid me at a separate link" implies and it is the honest fit for a CV builder (people job-hunt in bursts, then stop). Packs stack: `grant_purchase` extends from `greatest(plan_expires_at, now())`, so buying two gives 500 credits and 60 days rather than overwriting.

The trade: no recurring revenue, and re-acquiring the same user costs you the whole funnel again. Razorpay Subscriptions would fix that, at the price of a mandate flow, dunning, and cancellation handling. Not for launch. Revisit when you know the repeat-purchase rate, which is a question `payments` can answer for you in a month.
