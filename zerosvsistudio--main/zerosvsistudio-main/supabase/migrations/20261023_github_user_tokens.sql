-- Per-Zeros-user GitHub App OAuth tokens. Run this migration in the Supabase SQL editor before enabling the OAuth flow.
-- The server encrypts access/refresh tokens with AES-256-GCM before writing them. Never expose this table to browser roles.
create table if not exists public.zeros_github_user_tokens (
  user_id text primary key,
  github_user_id bigint not null,
  github_login text not null,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists zeros_github_user_tokens_github_user_id_idx
  on public.zeros_github_user_tokens (github_user_id);

alter table public.zeros_github_user_tokens enable row level security;
revoke all on table public.zeros_github_user_tokens from anon, authenticated;
grant select, insert, update, delete on table public.zeros_github_user_tokens to service_role;
