-- Per-app permissions: whether ZerosX2.0 may use an app in chat, and whether it may make changes in it.
-- Written only by the server (service role); each person can read their own permissions.

create table if not exists public.zeros_app_permissions (
  user_id text not null,
  toolkit_slug text not null check (toolkit_slug ~ '^[a-z0-9_-]{2,64}$'),
  enabled boolean not null default false,
  allow_writes boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, toolkit_slug)
);

alter table public.zeros_app_permissions enable row level security;

drop policy if exists "zeros_app_permissions_select_own" on public.zeros_app_permissions;
create policy "zeros_app_permissions_select_own" on public.zeros_app_permissions
  for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));
