-- ZerosX2.0: monthly subscriptions, promo access and per-account settings.
-- Run once, after 20261017000000_zeros_billing.sql. Safe to run again.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Monthly subscriptions. The plan row now remembers the PayPal subscription and the end of the month that was paid for.
--    Access exists only while now() <= paid_through (plus a short grace while PayPal reports the subscription ACTIVE).
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.zeros_billing
  add column if not exists subscription_id text,
  add column if not exists status text,
  add column if not exists paid_through timestamptz,
  add column if not exists cancel_requested boolean not null default false,
  add column if not exists checked_at timestamptz;

-- One PayPal subscription can belong to one account only.
create unique index if not exists zeros_billing_subscription_id_key
  on public.zeros_billing (subscription_id) where subscription_id is not null;

-- Plans bought before monthly billing existed were one-time purchases with no end date. They keep access for a 30-day
-- transition counted from the day this migration runs, then must subscribe monthly. Change the interval here to lengthen or
-- shorten that transition. No row is deleted.
update public.zeros_billing
   set status = 'LEGACY', paid_through = now() + interval '30 days'
 where subscription_id is null and paid_through is null;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Promo access. Only the server (service role) can read or write these tables; nobody can grant themselves access from the browser.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.zeros_promo (
  user_id text primary key,
  code_tag text not null,                      -- a fingerprint of the code that was redeemed, never the code itself
  redeemed_at timestamptz not null default now()
);

create table if not exists public.zeros_promo_attempts (
  bucket text primary key,                     -- 'u:<account>' or 'ip:<hash of the network address>'
  failures integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.zeros_promo enable row level security;
alter table public.zeros_promo_attempts enable row level security;
revoke all on public.zeros_promo from anon, authenticated;
revoke all on public.zeros_promo_attempts from anon, authenticated;
-- No policies on purpose: with row level security on and no policy, only the service role can touch them.

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Per-account settings: wallpaper, reasoning level and the memory switch follow the Google account, on every device,
--    and never leak from one account to another on a shared browser.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.zeros_user_settings (
  user_id text primary key,
  wallpaper jsonb,                             -- {"id":"aurora"} or {"id":"custom","dataUrl":"data:image/png;base64,..."}
  reasoning text check (reasoning in ('fast', 'medium', 'complex')),
  memory_enabled boolean,
  updated_at timestamptz not null default now(),
  constraint zeros_user_settings_wallpaper_size check (wallpaper is null or octet_length(wallpaper::text) <= 4000000)
);

alter table public.zeros_user_settings enable row level security;
revoke all on public.zeros_user_settings from anon;
grant select, insert, update, delete on public.zeros_user_settings to authenticated;
grant all on public.zeros_user_settings, public.zeros_promo, public.zeros_promo_attempts to service_role;

drop policy if exists "zeros_user_settings_select_own" on public.zeros_user_settings;
create policy "zeros_user_settings_select_own" on public.zeros_user_settings
  for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "zeros_user_settings_insert_own" on public.zeros_user_settings;
create policy "zeros_user_settings_insert_own" on public.zeros_user_settings
  for insert to authenticated
  with check ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "zeros_user_settings_update_own" on public.zeros_user_settings;
create policy "zeros_user_settings_update_own" on public.zeros_user_settings
  for update to authenticated
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);

drop policy if exists "zeros_user_settings_delete_own" on public.zeros_user_settings;
create policy "zeros_user_settings_delete_own" on public.zeros_user_settings
  for delete to authenticated
  using ((select auth.jwt()->>'sub') = user_id);
