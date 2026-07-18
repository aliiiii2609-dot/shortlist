-- Shortlist backend schema.
-- Run in Supabase: SQL Editor -> paste -> Run.
-- Supabase already gives you auth.users. Everything below hangs off it.

-- ─────────────────────────────────────────────────────────────
-- accounts: one row per signed-up user. The credit balance lives
-- here, not in the browser, because the browser is the attacker.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.accounts (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null,
  plan              text not null default 'free',        -- free | pro
  credits           integer not null default 15,          -- free trial grant
  uploads_used      integer not null default 0,
  uploads_limit     integer not null default 1,
  plan_expires_at   timestamptz,                          -- null = never (free)
  lifetime_paise    bigint not null default 0,            -- total ever paid, in paise
  blocked           boolean not null default false,
  blocked_reason    text,
  signup_ip         inet,
  created_at        timestamptz not null default now(),
  constraint credits_non_negative check (credits >= 0)
);

-- ─────────────────────────────────────────────────────────────
-- credit_ledger: every grant and every spend. Append only.
-- This is your source of truth when a user says "I was charged twice".
-- accounts.credits is a cached running total; this table can rebuild it.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.credit_ledger (
  id          bigserial primary key,
  user_id     uuid not null references public.accounts(id) on delete cascade,
  delta       integer not null,                -- +250 grant, -8 spend, +3 refund
  reason      text not null,                   -- 'purchase' | 'signup_grant' | action name | 'settle_refund'
  ref         text,                            -- razorpay payment id, or request id
  balance_after integer not null,
  created_at  timestamptz not null default now()
);
create index if not exists credit_ledger_user_time on public.credit_ledger (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- usage_events: one row per Anthropic call, with real token counts
-- and real cost. This is how you find out, on day 30, that Scribe is
-- eating 60% of your API bill. Without it you are flying blind.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.usage_events (
  id              bigserial primary key,
  user_id         uuid references public.accounts(id) on delete set null,
  action          text not null,
  model           text not null,
  input_tokens    integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens   integer not null default 0,
  cost_micros     bigint not null default 0,   -- USD millionths. integers, never floats, for money
  credits_charged integer not null default 0,
  status          integer not null default 200,
  duration_ms     integer,
  ip              inet,
  created_at      timestamptz not null default now()
);
create index if not exists usage_events_user_time on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_time on public.usage_events (created_at desc);

-- ─────────────────────────────────────────────────────────────
-- payments: idempotency for the Razorpay webhook. Razorpay retries.
-- The unique constraint on payment_id is what stops a retry from
-- granting 250 credits twice.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.payments (
  id                bigserial primary key,
  razorpay_payment_id text not null unique,
  razorpay_link_id  text,
  user_id           uuid references public.accounts(id) on delete set null,
  email             text,
  amount_paise      integer not null,
  credits_granted   integer not null default 0,
  status            text not null default 'captured',
  raw               jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists payments_user on public.payments (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- rate_counters: fixed-window counters. Cheap, boring, correct enough.
-- Swap for Upstash Redis only when Postgres actually complains.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.rate_counters (
  user_id      uuid not null,
  bucket       text not null,          -- 'min' | 'hour' | 'day'
  window_start timestamptz not null,
  n            integer not null default 0,
  primary key (user_id, bucket, window_start)
);
create index if not exists rate_counters_gc on public.rate_counters (window_start);

-- ─────────────────────────────────────────────────────────────
-- kill_switch: the thing that saves you at 3am.
-- One row. If spend_today_micros exceeds daily_cap_micros, /api/ai
-- returns 503 for everyone until you raise the cap. A bug that loops
-- an API call costs you the cap, not your card limit.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.kill_switch (
  id                 boolean primary key default true,
  enabled            boolean not null default true,
  daily_cap_micros   bigint not null default 3000000,   -- $3.00/day. Raise as you grow.
  spend_today_micros bigint not null default 0,
  day                date not null default current_date,
  constraint one_row check (id)
);
insert into public.kill_switch (id) values (true) on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- RLS. The API routes use the service_role key and bypass RLS entirely,
-- which is correct: all writes go through the SQL functions in 002.
-- These policies exist so that IF you ever query from the browser with
-- the anon key, a user can only ever see their own row.
-- ─────────────────────────────────────────────────────────────
alter table public.accounts       enable row level security;
alter table public.credit_ledger  enable row level security;
alter table public.usage_events   enable row level security;
alter table public.payments       enable row level security;

create policy "own account"  on public.accounts      for select using (auth.uid() = id);
create policy "own ledger"   on public.credit_ledger for select using (auth.uid() = user_id);
create policy "own usage"    on public.usage_events  for select using (auth.uid() = user_id);
create policy "own payments" on public.payments      for select using (auth.uid() = user_id);
-- Deliberately no insert/update/delete policies. Nothing writes from the browser.

-- ─────────────────────────────────────────────────────────────
-- Auto-create an account row when someone confirms their email.
-- ─────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  insert into public.credit_ledger (user_id, delta, reason, balance_after)
  values (new.id, 15, 'signup_grant', 15);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
