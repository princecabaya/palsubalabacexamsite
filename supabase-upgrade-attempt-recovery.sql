-- Teacher recovery tools for accidental student submission.
-- Run once in Supabase SQL Editor.

create or replace function public.admin_reopen_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $reopen$
declare
  v_updated integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  update public.attempts
  set status = 'active',
      submitted_at = null,
      score = null,
      max_score = null
  where id = p_attempt_id
    and status = 'submitted';

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    insert into public.proctor_events(attempt_id, event_type, details)
    values (
      p_attempt_id,
      'attempt_reopened_by_teacher',
      jsonb_build_object(
        'teacher_user_id', auth.uid(),
        'reopened_at', now()
      )
    );
  end if;

  return v_updated = 1;
end;
$reopen$;

create or replace function public.admin_reset_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $reset$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  -- Child records are also protected by ON DELETE CASCADE, but explicit
  -- deletion makes the reset behavior clear and removes saved work first.
  delete from public.responses where attempt_id = p_attempt_id;
  delete from public.proctor_events where attempt_id = p_attempt_id;
  delete from public.proctor_photos where attempt_id = p_attempt_id;

  delete from public.attempts
  where id = p_attempt_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$reset$;

revoke all on function public.admin_reopen_attempt(uuid) from public;
revoke all on function public.admin_reset_attempt(uuid) from public;
grant execute on function public.admin_reopen_attempt(uuid) to authenticated;
grant execute on function public.admin_reset_attempt(uuid) to authenticated;
