-- Exam Guard: extend ordinary proctor-photo retention from 24 hours to 7 days.
-- Run once in Supabase SQL Editor.
-- Preserved evidence remains exempt from cleanup until released.

alter table public.proctor_photos
  alter column expires_at
  set default (now() + interval '7 days');

-- Extend still-existing photo metadata to at least 7 days from capture.
-- This cannot restore photos that were already deleted by an earlier cleanup.
update public.proctor_photos
set expires_at = greatest(
  expires_at,
  captured_at + interval '7 days'
)
where expires_at > now();

-- Verification:
-- select captured_at, expires_at, evidence_saved
-- from public.proctor_photos
-- order by captured_at desc
-- limit 20;
