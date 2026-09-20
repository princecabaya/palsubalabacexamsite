-- Exam Guard: archive exams + delete individual student attempts
-- Run ONCE in Supabase SQL Editor.
-- This upgrade is non-destructive: it does not delete any current data.

-- 1) Add soft-archive fields to exams.
alter table public.exams
  add column if not exists archived boolean not null default false;

alter table public.exams
  add column if not exists archived_at timestamptz;

-- 2) Allow authenticated Exam Guard administrators to delete an attempt.
-- Deleting an attempt automatically removes its responses and proctoring events
-- because those tables reference attempts with ON DELETE CASCADE.
drop policy if exists admin_attempts_delete on public.attempts;

create policy admin_attempts_delete on public.attempts
for delete to authenticated
using (public.exam_guard_current_user_is_admin());

grant delete on public.attempts to authenticated;

-- Exam deletion is already covered by the existing admin_exams FOR ALL policy
-- and DELETE grant. Questions and attempts are deleted by ON DELETE CASCADE.

-- Optional verification:
select
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'exams'
  and column_name in ('archived','archived_at')
order by column_name;
