-- The concurrency-safe core. Read the comments; this is the part that
-- breaks silently if you write it the obvious way.

-- ═════════════════════════════════════════════════════════════
-- spend_credits
--
-- The naive version everyone writes first:
--     const acct = await db.select(...)          -- reads credits = 5
--     if (acct.credits < cost) return 402
--     await db.update({ credits: acct.credits - cost })
--
-- Open two tabs, click twice at once, and both reads see 5, both pass
-- the check, both write 5 - 8. You just gave away free credits, and at
-- 2000 users someone WILL find this by accident within a week.
--
-- The fix is not a transaction or a mutex. It is doing the check and the
-- write in ONE statement. `where credits >= p_cost` is evaluated by
-- Postgres under a row lock, so the second UPDATE re-reads the row after
-- the first commits, sees -3, matches nothing, and returns not-found.
-- ═════════════════════════════════════════════════════════════
create or replace function public.spend_credits(
  p_user uuid,
  p_cost integer,
  p_action text,
  p_ref text default null
) returns table (ok boolean, remaining integer, reason text)
language plpgsql security definer set search_path = public as $$
declare
  v_remaining integer;
  v_acct public.accounts%rowtype;
begin
  update public.accounts
     set credits = credits - p_cost
   where id = p_user
     and not blocked
     and credits >= p_cost
     and (plan_expires_at is null or plan_expires_at > now())
  returning credits into v_remaining;

  if found then
    insert into public.credit_ledger (user_id, delta, reason, ref, balance_after)
    values (p_user, -p_cost, p_action, p_ref, v_remaining);
    return query select true, v_remaining, null::text;
    return;
  end if;

  -- Did not spend. Work out why, for a useful error message.
  select * into v_acct from public.accounts where id = p_user;
  if not found then
    return query select false, 0, 'no_account'::text;
  elsif v_acct.blocked then
    return query select false, v_acct.credits, 'blocked'::text;
  elsif v_acct.plan_expires_at is not null and v_acct.plan_expires_at <= now() then
    return query select false, v_acct.credits, 'expired'::text;
  else
    return query select false, v_acct.credits, 'insufficient_credits'::text;
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════
-- refund_credits
-- Called after the real token usage comes back. We charge an estimate up
-- front (so a user cannot fire 100 concurrent calls on 1 credit), then
-- reconcile down. Also used when the Anthropic call fails: the user
-- should not pay for our 500.
-- ═════════════════════════════════════════════════════════════
create or replace function public.refund_credits(
  p_user uuid, p_amount integer, p_reason text, p_ref text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_remaining integer;
begin
  if p_amount <= 0 then
    select credits into v_remaining from public.accounts where id = p_user;
    return coalesce(v_remaining, 0);
  end if;
  update public.accounts set credits = credits + p_amount
   where id = p_user returning credits into v_remaining;
  insert into public.credit_ledger (user_id, delta, reason, ref, balance_after)
  values (p_user, p_amount, p_reason, p_ref, v_remaining);
  return v_remaining;
end $$;

-- ═════════════════════════════════════════════════════════════
-- grant_purchase
-- Called by the Razorpay webhook. Idempotent on razorpay_payment_id:
-- Razorpay retries a webhook until you 200 it, so this WILL be called
-- twice for the same payment. The `on conflict do nothing` + `not found`
-- guard means the second call grants zero.
-- ═════════════════════════════════════════════════════════════
create or replace function public.grant_purchase(
  p_payment_id text,
  p_link_id text,
  p_user uuid,
  p_email text,
  p_amount_paise integer,
  p_credits integer,
  p_uploads integer,
  p_valid_days integer,
  p_raw jsonb
) returns table (granted boolean, credits integer)
language plpgsql security definer set search_path = public as $$
declare v_credits integer;
begin
  insert into public.payments (razorpay_payment_id, razorpay_link_id, user_id, email,
                               amount_paise, credits_granted, raw)
  values (p_payment_id, p_link_id, p_user, p_email, p_amount_paise, p_credits, p_raw)
  on conflict (razorpay_payment_id) do nothing;

  if not found then
    -- already processed. Return current balance, grant nothing.
    select credits into v_credits from public.accounts where id = p_user;
    return query select false, coalesce(v_credits, 0);
    return;
  end if;

  update public.accounts
     set plan = 'pro',
         credits = credits + p_credits,
         uploads_limit = uploads_limit + p_uploads,
         lifetime_paise = lifetime_paise + p_amount_paise,
         -- extend from whichever is later: now, or an unexpired existing plan.
         -- Stacking two packs should give 60 days, not overwrite to 30.
         plan_expires_at = greatest(coalesce(plan_expires_at, now()), now())
                           + (p_valid_days || ' days')::interval
   where id = p_user
  returning credits into v_credits;

  insert into public.credit_ledger (user_id, delta, reason, ref, balance_after)
  values (p_user, p_credits, 'purchase', p_payment_id, v_credits);

  return query select true, v_credits;
end $$;

-- ═════════════════════════════════════════════════════════════
-- bump_rate
-- Fixed-window counter. Returns the count AFTER incrementing, so the
-- caller compares against its own limit. One round trip, atomic.
--
-- Fixed windows allow a 2x burst at a boundary (10 at 11:59:59, 10 at
-- 12:00:00). That is fine here: this is an abuse brake, not a billing
-- control. Credits are the billing control, and those are exact.
-- ═════════════════════════════════════════════════════════════
create or replace function public.bump_rate(
  p_user uuid, p_bucket text, p_window_seconds integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz;
  v_n integer;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_counters (user_id, bucket, window_start, n)
  values (p_user, p_bucket, v_start, 1)
  on conflict (user_id, bucket, window_start)
  do update set n = public.rate_counters.n + 1
  returning n into v_n;
  return v_n;
end $$;

-- ═════════════════════════════════════════════════════════════
-- check_kill_switch / record_spend
-- The global daily cap. Every call adds its real cost; when the day's
-- total crosses the cap, everything 503s until you raise it.
--
-- Per-user limits protect you from one bad user. This protects you from
-- a bad DEPLOY: a retry loop, a runaway useEffect, a prompt that makes
-- the model emit 8k tokens every time. Those hit every user at once and
-- per-user limits do nothing.
-- ═════════════════════════════════════════════════════════════
create or replace function public.check_kill_switch()
returns table (ok boolean, spent bigint, cap bigint)
language plpgsql security definer set search_path = public as $$
declare k public.kill_switch%rowtype;
begin
  update public.kill_switch
     set spend_today_micros = case when day < current_date then 0 else spend_today_micros end,
         day = current_date
   where id = true returning * into k;
  return query select (not k.enabled) or (k.spend_today_micros < k.daily_cap_micros),
                      k.spend_today_micros, k.daily_cap_micros;
end $$;

create or replace function public.record_spend(p_micros bigint)
returns void language sql security definer set search_path = public as $$
  update public.kill_switch
     set spend_today_micros = case when day < current_date then p_micros
                                   else spend_today_micros + p_micros end,
         day = current_date
   where id = true;
$$;

-- ═════════════════════════════════════════════════════════════
-- Housekeeping. rate_counters grows forever otherwise.
-- Supabase Dashboard -> Integrations -> Cron -> run daily.
-- ═════════════════════════════════════════════════════════════
create or replace function public.gc_rate_counters()
returns void language sql security definer set search_path = public as $$
  delete from public.rate_counters where window_start < now() - interval '2 days';
$$;

-- Referenced by api/ai.js when an upload is counted but the credit spend
-- then fails. Two quotas, two failure points; give back what you took.
create or replace function public.refund_uploads(p_user uuid, p_n integer)
returns void language sql security definer set search_path = public as $$
  update public.accounts set uploads_used = greatest(0, uploads_used - p_n) where id = p_user;
$$;
