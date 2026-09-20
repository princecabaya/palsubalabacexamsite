-- One-time upgrade for AI feedback storage.
-- Run this in Supabase SQL Editor AFTER the main supabase-schema.sql has been installed.

alter table public.responses
  add column if not exists ai_feedback text;

alter table public.responses
  add column if not exists feedback_generated_at timestamptz;

comment on column public.responses.ai_feedback is
  'AI-generated formative feedback for an incorrect auto-scored response.';

comment on column public.responses.feedback_generated_at is
  'Timestamp when AI feedback was last generated.';
