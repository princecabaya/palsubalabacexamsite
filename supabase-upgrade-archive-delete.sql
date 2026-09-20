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


-- 3) Reliable admin-only delete RPC.
-- This avoids silent zero-row deletes caused by browser-side RLS filtering.
create or replace function public.admin_delete_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null or not public.exam_guard_current_user_is_admin() then
    raise exception 'Administrator access required.';
  end if;

  delete from public.attempts
  where id = p_attempt_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.admin_delete_attempt(uuid) from public;
grant execute on function public.admin_delete_attempt(uuid) to authenticated;
