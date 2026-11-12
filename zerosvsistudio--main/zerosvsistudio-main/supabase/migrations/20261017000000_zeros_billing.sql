-- ZerosX2.0 billing: plans, daily request usage (24-hour windows) and PayPal purchase claims.
-- Writes come only from the server (service role). Each person can read their own plan and usage.

create table if not exists public.zeros_billing (
  user_id text primary key,
  plan text not null check (plan in ('bronze', 'gold')),
  plan_updated_at timestamptz not null default now()
);

create table if not exists public.zeros_usage (
  user_id text primary key,
  window_start timestamptz not null default now(),
  used_units integer not null default 0 check (used_units >= 0)
);

create table if not exists public.zeros_paypal_claims (
  transaction_id text primary key,
  user_id text not null,
  plan text not null check (plan in ('bronze', 'gold')),
  amount text not null,
  payer_email text,
  claimed_at timestamptz not null default now()
);

alter table public.zeros_billing enable row level security;
alter table public.zeros_usage enable row level security;
alter table public.zeros_paypal_claims enable row level security;

drop policy if exists "zeros_billing_select_own" on public.zeros_billing;
create policy "zeros_billing_select_own" on public.zeros_billing
  for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));

drop policy if exists "zeros_usage_select_own" on public.zeros_usage;
create policy "zeros_usage_select_own" on public.zeros_usage
  for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));

-- zeros_paypal_claims has no policies: only the service role can read or write it.

-- Charges (or refunds, with negative units) atomically. The row is locked, so concurrent requests cannot overspend.
create or replace function public.zeros_consume_usage(p_user text, p_units integer, p_limit integer, p_now timestamptz)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_used integer;
  v_new integer;
  v_limit_units integer := p_limit * 10;
begin
  insert into public.zeros_usage (user_id, window_start, used_units)
  values (p_user, p_now, 0)
  on conflict (user_id) do nothing;

  select window_start, used_units into v_start, v_used
  from public.zeros_usage where user_id = p_user for update;

  if p_now - v_start >= interval '24 hours' then
    v_start := p_now;
    v_used := 0;
  end if;

  if p_units < 0 then
    v_new := greatest(0, v_used + p_units);
  else
    if v_used + p_units > v_limit_units then
      return json_build_object('allowed', false, 'used_units', v_used, 'window_start', v_start);
    end if;
    v_new := v_used + p_units;
  end if;

  update public.zeros_usage set window_start = v_start, used_units = v_new where user_id = p_user;
  return json_build_object('allowed', true, 'used_units', v_new, 'window_start', v_start);
end;
$$;

revoke all on function public.zeros_consume_usage(text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.zeros_consume_usage(text, integer, integer, timestamptz) to service_role;
