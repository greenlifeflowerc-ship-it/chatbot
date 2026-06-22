-- Token storage for Instagram Business Login.
-- A single row holds the access token the backend obtained via OAuth. Only the
-- backend (service-role) touches it; RLS is on with no policies so the anon /
-- dashboard role can never read the token.
--
-- Run this once in the Supabase SQL editor (in addition to the main schema).
create table if not exists instagram_credentials (
  id           int primary key default 1,
  ig_user_id   text,
  access_token text not null,
  token_type   text,
  expires_at   timestamptz,
  updated_at   timestamptz not null default now(),
  constraint single_row check (id = 1)
);

alter table instagram_credentials enable row level security;
