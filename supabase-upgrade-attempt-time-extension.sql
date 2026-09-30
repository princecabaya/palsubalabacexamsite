-- Exam Guard: safe per-student time extensions for active attempts.
-- Run once in Supabase SQL Editor.
-- This does NOT change the exam duration for other students.

alter table public.attempts
  add column if not exists extended_until timestamptz;

create or replace function public.exam_guard_attempt_ends_at(p_attempt_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    least(
      a.started_at + make_interval(mins => e.duration_minutes),
      coalesce(e.end_at, 'infinity'::timestamptz)
    ),
    coalesce(a.extended_until, '-infinity'::timestamptz)
  )
  from public.attempts a
  join public.exams e on e.id = a.exam_id
  where a.id = p_attempt_id;
$$;

revoke all on function public.exam_guard_attempt_ends_at(uuid) from public;
grant execute on function public.exam_guard_attempt_ends_at(uuid) to anon, authenticated;

create or replace function public.admin_extend_attempt_time(
  p_attempt_id uuid,
  p_minutes integer
)
returns table(
  added_minutes integer,
  ends_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_current_end timestamptz;
  v_new_end timestamptz;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'Time extension must be between 1 and 240 minutes.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id
  for update;

  if not found then
    raise exception 'Exam attempt was not found.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Time can only be added to an active exam attempt.';
  end if;

  v_current_end := public.exam_guard_attempt_ends_at(p_attempt_id);

  -- Add time to the student's current effective deadline.
  v_new_end := v_current_end + make_interval(mins => p_minutes);

  update public.attempts
  set extended_until = v_new_end
  where id = p_attempt_id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'time_extended_by_teacher',
    jsonb_build_object(
      'added_minutes', p_minutes,
      'previous_ends_at', v_current_end,
      'new_ends_at', v_new_end,
      'teacher_user_id', auth.uid()
    )
  );

  return query select p_minutes, v_new_end;
end;
$$;

revoke all on function public.admin_extend_attempt_time(uuid,integer) from public;
grant execute on function public.admin_extend_attempt_time(uuid,integer) to authenticated;

create or replace function public.get_attempt_time_state(
  p_attempt_token uuid
)
returns table(
  ends_at timestamptz,
  extended_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_end timestamptz;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  v_end := public.exam_guard_attempt_ends_at(v_attempt.id);

  return query select v_end, v_attempt.extended_until;
end;
$$;

revoke all on function public.get_attempt_time_state(uuid) from public;
grant execute on function public.get_attempt_time_state(uuid) to anon, authenticated;

-- Update the active 4-argument start RPC to respect per-attempt extension.
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

  if v_exam.start_at is not null and now() < v_exam.start_at then
    raise exception 'This exam has not opened yet.';
  end if;

  if v_exam.end_at is not null and now() > v_exam.end_at then
    raise exception 'This exam is already closed.';
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
    if v_attempt.status = 'submitted' then
      raise exception 'This student has already submitted this exam.';
    end if;

    v_ends_at := public.exam_guard_attempt_ends_at(v_attempt.id);

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
    insert into public.attempts(
      exam_id,student_id,user_agent,active_session_id,session_locked_at
    )
    values(
      v_exam.id,v_student.id,left(p_user_agent,2000),p_device_session,now()
    )
    returning * into v_attempt;

    v_ends_at := public.exam_guard_attempt_ends_at(v_attempt.id);
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

create or replace function public.resume_exam(
  p_attempt_token uuid,
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
as $resume$
declare
  v_attempt public.attempts%rowtype;
  v_exam public.exams%rowtype;
  v_student public.students%rowtype;
  v_ends_at timestamptz;
begin
  if p_device_session is null then
    raise exception 'A browser session identifier is required.';
  end if;

  select * into v_attempt
  from public.attempts
  where attempts.attempt_token = p_attempt_token
  for update;

  if not found or v_attempt.status <> 'active' then
    raise exception 'No active exam session was found.';
  end if;

  if v_attempt.active_session_id is null then
    update public.attempts
    set active_session_id = p_device_session,
        session_locked_at = now()
    where id = v_attempt.id
    returning * into v_attempt;
  elsif v_attempt.active_session_id <> p_device_session then
    raise exception 'This exam session is locked to another browser or device. Contact the teacher to unlock it.';
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;
  select * into v_student from public.students where id = v_attempt.student_id;

  v_ends_at := public.exam_guard_attempt_ends_at(v_attempt.id);

  if now() > v_ends_at then
    update public.attempts
    set status = 'expired',
        active_session_id = null,
        session_locked_at = null
    where id = v_attempt.id;
    raise exception 'The saved exam session has expired.';
  end if;

  return query
  select
    v_attempt.attempt_token,
    v_exam.title,
    v_student.full_name,
    v_student.student_no,
    v_attempt.started_at,
    v_ends_at;
end;
$resume$;

-- Respect extensions when loading questions.
create or replace function public.get_exam_questions(p_attempt_token uuid)
returns table(
  question_id uuid,
  "position" integer,
  section_title text,
  prompt text,
  question_type text,
  choices jsonb,
  points numeric,
  rubric_type text,
  rubric_criteria jsonb,
  stimulus_type text,
  stimulus_payload jsonb
)
language plpgsql
security definer
set search_path = public
as $questions$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now() > public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts set status = 'expired' where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  return query
  select
    q.id,q.position,q.section_title,q.prompt,q.question_type,q.choices,q.points,
    q.rubric_type,q.rubric_criteria,q.stimulus_type,q.stimulus_payload
  from public.questions q
  where q.exam_id = v_attempt.exam_id
  order by q.position;
end;
$questions$;

-- Respect extensions while autosaving answers.
create or replace function public.save_exam_response(
  p_attempt_token uuid,
  p_question_id uuid,
  p_answer text
)
returns void
language plpgsql
security definer
set search_path = public
as $save$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now() > public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts set status = 'expired' where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  if not exists(
    select 1 from public.questions
    where id = p_question_id and exam_id = v_attempt.exam_id
  ) then
    raise exception 'Question does not belong to this exam.';
  end if;

  insert into public.responses(attempt_id,question_id,answer,saved_at)
  values(v_attempt.id,p_question_id,left(p_answer,20000),now())
  on conflict(attempt_id,question_id)
  do update set answer=excluded.answer,saved_at=now();
end;
$save$;

revoke all on function public.start_exam(text,text,text,uuid) from public;
revoke all on function public.resume_exam(uuid,uuid) from public;
revoke all on function public.get_exam_questions(uuid) from public;
revoke all on function public.save_exam_response(uuid,uuid,text) from public;
grant execute on function public.start_exam(text,text,text,uuid) to anon, authenticated;
grant execute on function public.resume_exam(uuid,uuid) to anon, authenticated;
grant execute on function public.get_exam_questions(uuid) to anon, authenticated;
grant execute on function public.save_exam_response(uuid,uuid,text) to anon, authenticated;
