-- Exam Guard: teacher remote submission using Supabase-saved responses.
-- Safe additive upgrade while attempts are active.
-- This submits only responses already stored in public.responses.

create or replace function public.admin_submit_saved_attempt(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_saved_count integer := 0;
  v_total_count integer := 0;
  v_score numeric;
  v_max_score numeric;
  v_submitted_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Teacher sign-in is required.';
  end if;

  if not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this attempt.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id
  for update;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if v_attempt.status = 'submitted' then
    return jsonb_build_object(
      'ok', true,
      'already_submitted', true,
      'saved_response_count', (
        select count(*)
        from public.responses
        where attempt_id = p_attempt_id
          and btrim(coalesce(answer,'')) <> ''
      ),
      'total_question_count', (
        select count(*)
        from public.questions
        where exam_id = v_attempt.exam_id
      ),
      'score', v_attempt.score,
      'max_score', v_attempt.max_score,
      'submitted_at', v_attempt.submitted_at
    );
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Only an active attempt can be submitted remotely. Reopen the attempt first if necessary.';
  end if;

  select count(*) into v_saved_count
  from public.responses
  where attempt_id = p_attempt_id
    and btrim(coalesce(answer,'')) <> '';

  select count(*) into v_total_count
  from public.questions
  where exam_id = v_attempt.exam_id;

  -- Use the same canonical scoring/submission routine as normal student submission.
  select s.score, s.max_score
  into v_score, v_max_score
  from public.submit_exam(v_attempt.attempt_token) s
  limit 1;

  select submitted_at into v_submitted_at
  from public.attempts
  where id = p_attempt_id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'teacher_remote_submit',
    jsonb_build_object(
      'teacher_user_id', auth.uid(),
      'saved_response_count', v_saved_count,
      'total_question_count', v_total_count,
      'submitted_at', v_submitted_at
    )
  );

  return jsonb_build_object(
    'ok', true,
    'already_submitted', false,
    'saved_response_count', v_saved_count,
    'total_question_count', v_total_count,
    'score', v_score,
    'max_score', v_max_score,
    'submitted_at', v_submitted_at
  );
end;
$$;

revoke all on function public.admin_submit_saved_attempt(uuid) from public;
grant execute on function public.admin_submit_saved_attempt(uuid) to authenticated;
