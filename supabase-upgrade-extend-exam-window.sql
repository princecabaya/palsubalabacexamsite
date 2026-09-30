-- Exam Guard: extend the published exam window for everyone.
-- Safe additive upgrade while attempts are active.

create or replace function public.admin_extend_exam_window(
  p_exam_id uuid,
  p_new_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_old_end timestamptz;
  v_old_duration integer;
  v_required_duration integer;
  v_new_duration integer;
begin
  if auth.uid() is null or not public.exam_guard_can_access_exam(p_exam_id) then
    raise exception 'You do not have access to this examination.';
  end if;

  select * into v_exam
  from public.exams
  where id = p_exam_id
  for update;

  if not found then
    raise exception 'Exam not found.';
  end if;

  if p_new_end_at is null then
    raise exception 'New closing time is required.';
  end if;

  if v_exam.start_at is not null and p_new_end_at <= v_exam.start_at then
    raise exception 'New closing time must be later than the exam start time.';
  end if;

  if v_exam.end_at is not null and p_new_end_at <= v_exam.end_at then
    raise exception 'New closing time must be later than the current closing time.';
  end if;

  v_old_end := v_exam.end_at;
  v_old_duration := v_exam.duration_minutes;

  if v_exam.start_at is not null then
    v_required_duration := greatest(
      1,
      ceil(extract(epoch from (p_new_end_at - v_exam.start_at)) / 60.0)::integer
    );
  else
    v_required_duration := v_old_duration;
  end if;

  v_new_duration := greatest(v_old_duration, v_required_duration);

  if v_new_duration > 600 then
    raise exception 'The resulting duration exceeds the 600-minute system limit.';
  end if;

  update public.exams
  set end_at = p_new_end_at,
      duration_minutes = v_new_duration
  where id = p_exam_id;

  insert into public.proctor_events(attempt_id,event_type,details)
  select
    a.id,
    'exam_window_extended_by_teacher',
    jsonb_build_object(
      'previous_end_at', v_old_end,
      'new_end_at', p_new_end_at,
      'previous_duration_minutes', v_old_duration,
      'new_duration_minutes', v_new_duration,
      'teacher_user_id', auth.uid()
    )
  from public.attempts a
  where a.exam_id = p_exam_id
    and a.status = 'active';

  return jsonb_build_object(
    'ok', true,
    'previous_end_at', v_old_end,
    'new_end_at', p_new_end_at,
    'previous_duration_minutes', v_old_duration,
    'new_duration_minutes', v_new_duration
  );
end;
$$;

revoke all on function public.admin_extend_exam_window(uuid,timestamptz) from public;
grant execute on function public.admin_extend_exam_window(uuid,timestamptz) to authenticated;
