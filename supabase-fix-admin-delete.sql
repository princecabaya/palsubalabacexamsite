-- Reliable admin deletion fix for Exam Guard.
-- Run this entire file ONCE in Supabase SQL Editor.
-- Installing these functions does not delete any records by itself.

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

create or replace function public.admin_delete_exam(p_exam_id uuid)
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

  delete from public.exams
  where id = p_exam_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.admin_delete_attempt(uuid) from public;
revoke all on function public.admin_delete_exam(uuid) from public;

grant execute on function public.admin_delete_attempt(uuid) to authenticated;
grant execute on function public.admin_delete_exam(uuid) to authenticated;

-- Verify installation:
select routine_name
from information_schema.routines
where routine_schema='public'
  and routine_name in ('admin_delete_attempt','admin_delete_exam')
order by routine_name;
