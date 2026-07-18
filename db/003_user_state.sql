-- ─────────────────────────────────────────────────────────────
-- user_state: the cloud version of the browser's key/value store.
--
-- The app persists everything (all CV versions, the active id, parked
-- drafts, the profile) through an async get/set/delete/list contract that
-- used to sit on localStorage. localStorage is per-device, so a CV made on a
-- phone did not exist on a laptop. Once someone has PAID for the product,
-- that is not a quirk, it is a refund request.
--
-- This table is that same key/value store, server-side, one namespace per
-- user. The browser writes here with the user's own JWT; RLS below makes it
-- physically impossible to read or write another user's rows, so isolation
-- does not depend on the client getting anything right.
--
-- Values are jsonb. The largest single value is the full CV set, which the
-- app already caps at ~4.6 MB before it writes, comfortably under Postgres
-- limits. No blobs, no files, just the same JSON the app already produces.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.user_state (
  user_id     uuid not null references auth.users(id) on delete cascade,
  k           text not null,
  v           jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, k)
);

create index if not exists user_state_user on public.user_state (user_id);

alter table public.user_state enable row level security;

-- Unlike accounts/ledger/usage (read-only to the client, written only by the
-- service role), this table IS written by the browser: it is the user's own
-- workspace, and there is nothing sensitive in it that the user does not
-- already have. So the client gets full CRUD, but every policy is fenced to
-- auth.uid() = user_id. A user can touch their rows and no others.
create policy "own state read"   on public.user_state
  for select using (auth.uid() = user_id);
create policy "own state insert" on public.user_state
  for insert with check (auth.uid() = user_id);
create policy "own state update" on public.user_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own state delete" on public.user_state
  for delete using (auth.uid() = user_id);

-- Keep updated_at honest on every write, so "last saved" is trustworthy.
create or replace function public.touch_user_state()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists user_state_touch on public.user_state;
create trigger user_state_touch
  before update on public.user_state
  for each row execute function public.touch_user_state();
