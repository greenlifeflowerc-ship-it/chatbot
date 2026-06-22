-- Editable business profile that shapes the bot's replies. Stored as a single
-- JSONB column so fields can be added without further migrations.
-- Run once in the Supabase SQL editor.
alter table bot_settings
  add column if not exists business_profile jsonb not null default '{}'::jsonb;
