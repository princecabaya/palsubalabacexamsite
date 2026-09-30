-- Exam Guard: teacher-permitted editing after final submission.
-- Additive upgrade. The teacher grants a time-limited edit window.

alter table public.attempts
  add column if not exists edit_permitted_until timestamptz,
  add column if not exists edit_permitted_by uuid references auth.users(id) on delete set null,
  add column if not exists edit_permission_granted_at timestamptz;

create or replace function public.admin_permit_submitted_attempt_edit(
  p_attempt_id uuid,
  p_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_until timestamptz;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can permit editing.';
  end if;

  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'Editing permission must be between 1 and 240 minutes.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id
  for update;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if v_attempt.status <> 'submitted' then
    raise exception 'Editing permission can only be granted to a submitted attempt.';
  end if;

  v_until := now() + make_interval(mins => p_minutes);

  update public.attempts
  set status = 'active',
      submitted_at = null,
      score = null,
      max_score = null,
      provisional_score = null,
      provisional_max_score = null,
      grading_status = 'pending_review',
      edit_permitted_until = v_until,
      edit_permitted_by = auth.uid(),
      edit_permission_granted_at = now(),
      extended_until = greatest(coalesce(extended_until, '-infinity'::timestamptz), v_until),
      active_session_id = null,
      session_locked_at = null
  where id = p_attempt_id;

  -- Individually submitted essays must become editable again for this authorized revision.
  update public.responses
  set essay_submitted_at = null
  where attempt_id = p_attempt_id
    and essay_submitted_at is not null;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'post_submission_edit_permitted',
    jsonb_build_object(
      'teacher_user_id', auth.uid(),
      'minutes', p_minutes,
      'permitted_until', v_until
    )
  );

  return jsonb_build_object(
    'ok', true,
    'minutes', p_minutes,
    'permitted_until', v_until
  );
end;
$$;

revoke all on function public.admin_permit_submitted_attempt_edit(uuid,integer) from public;
grant execute on function public.admin_permit_submitted_attempt_edit(uuid,integer) to authenticated;

-- Updated start_exam: a student with explicit edit permission may re-enter the same
-- attempt after the normal exam closing time. New students still cannot enter a closed exam.
create or replace function public.start_exam(
  p_exam_code text,
  p_student_no text,
  p_user_agent text,
  p_device_session uuid
)
returns table(
  attempt_token uuid,
  exam_title text,
  student_name text,
  student_no text,
  started_at timestamptz,
  ends_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $start$
declare
  v_exam public.exams%rowtype;
  v_student public.students%rowtype;
  v_attempt public.attempts%rowtype;
  v_ends_at timestamptz;
  v_has_edit_permission boolean := false;
begin
  if p_device_session is null then
    raise exception 'A browser session identifier is required.';
  end if;

  select * into v_exam
  from public.exams
  where lower(code) = lower(trim(p_exam_code))
    and status = 'published'
    and coalesce(archived, false) = false;

  if not found then
    raise exception 'Exam code is invalid or the exam is not published.';
  end if;

  select s.* into v_student
  from public.students s
  where public.exam_guard_normalize_student_no(s.student_no)
        = public.exam_guard_normalize_student_no(p_student_no)
    and s.active = true;

  if not found then
    raise exception 'Student ID does not match an active student record.';
  end if;

  select * into v_attempt
  from public.attempts
  where exam_id = v_exam.id
    and student_id = v_student.id
  for update;

  if found then
    v_has_edit_permission :=
      v_attempt.status = 'active'
      and v_attempt.edit_permitted_until is not null
      and now() <= v_attempt.edit_permitted_until;

    if v_attempt.status = 'submitted' then
      raise exception 'This student has already submitted this exam. Teacher permission is required before editing.';
    end if;

    if v_exam.start_at is not null and now() < v_exam.start_at and not v_has_edit_permission then
      raise exception 'This exam has not opened yet.';
    end if;

    if v_exam.end_at is not null and now() > v_exam.end_at and not v_has_edit_permission then
      raise exception 'This exam is already closed.';
    end if;

    v_ends_at := public.exam_guard_attempt_ends_at(v_attempt.id);

    if v_has_edit_permission then
      v_ends_at := greatest(v_ends_at, v_attempt.edit_permitted_until);
    end if;

    if now() > v_ends_at then
      update public.attempts
      set status = 'expired',
          active_session_id = null,
          session_locked_at = null
      where id = v_attempt.id;
      raise exception 'The existing exam attempt has expired.';
    end if;

    if v_attempt.active_session_id is null then
      update public.attempts
      set active_session_id = p_device_session,
          session_locked_at = now(),
          user_agent = coalesce(left(p_user_agent, 2000), user_agent)
      where id = v_attempt.id
      returning * into v_attempt;
    elsif v_attempt.active_session_id <> p_device_session then
      raise exception 'This student already has an active exam session on another browser or device. Contact the teacher if the original session is no longer available.';
    end if;
  else
    if v_exam.start_at is not null and now() < v_exam.start_at then
      raise exception 'This exam has not opened yet.';
    end if;

    if v_exam.end_at is not null and now() > v_exam.end_at then
      raise exception 'This exam is already closed.';
    end if;

    insert into public.attempts(
      exam_id,student_id,user_agent,active_session_id,session_locked_at
    )
    values(
      v_exam.id,v_student.id,left(p_user_agent,2000),p_device_session,now()
    )
    returning * into v_attempt;
  end if;

  return query
  select
    v_attempt.attempt_token,
    v_exam.title,
    v_student.full_name,
    v_student.student_no,
    v_attempt.started_at,
    public.exam_guard_attempt_ends_at(v_attempt.id);
end;
$start$;

revoke all on function public.start_exam(text,text,text,uuid) from public;
grant execute on function public.start_exam(text,text,text,uuid) to anon, authenticated;
