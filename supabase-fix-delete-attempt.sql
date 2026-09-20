-- Fix for Delete Attempt not removing the record.
-- Run this once in Supabase SQL Editor.
-- It does not delete anything when installed; it only creates the admin-only delete function.

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

-- Verify that the function exists:
select
  routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'admin_delete_attempt';
