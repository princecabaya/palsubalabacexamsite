-- Active device/session lock for student exam attempts.
-- Run once in Supabase SQL Editor.

alter table public.attempts
  add column if not exists active_session_id uuid,
  add column if not exists session_locked_at timestamptz;


-- Automatically release the browser lock whenever an attempt stops being active.
create or replace function public.exam_guard_release_session_lock_when_inactive()
returns trigger
language plpgsql
set search_path = public
as $lock_trigger$
begin
  if new.status <> 'active' then
    new.active_session_id := null;
    new.session_locked_at := null;
  end if;
  return new;
end;
$lock_trigger$;

drop trigger if exists exam_guard_release_session_lock_when_inactive on public.attempts;
create trigger exam_guard_release_session_lock_when_inactive
before insert or update of status on public.attempts
for each row
execute function public.exam_guard_release_session_lock_when_inactive();

-- Replace the old 3-argument start API so an anonymous caller cannot bypass the lock.
drop function if exists public.start_exam(text,text,text);

create function public.start_exam(
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

    if now() > v_attempt.started_at + make_interval(mins => v_exam.duration_minutes) then
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
      exam_id,
      student_id,
      user_agent,
      active_session_id,
      session_locked_at
    )
    values(
      v_exam.id,
      v_student.id,
      left(p_user_agent, 2000),
      p_device_session,
      now()
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
    least(
      v_attempt.started_at + make_interval(mins => v_exam.duration_minutes),
      coalesce(v_exam.end_at, 'infinity'::timestamptz)
    );
end;
$start$;

drop function if exists public.resume_exam(uuid);

create function public.resume_exam(
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

  v_ends_at := least(
    v_attempt.started_at + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.end_at, 'infinity'::timestamptz)
  );

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

create or replace function public.admin_unlock_attempt_session(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $unlock$
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to unlock this exam attempt.';
  end if;

  update public.attempts
  set active_session_id = null,
      session_locked_at = null
  where id = p_attempt_id
    and status = 'active';

  return found;
end;
$unlock$;

revoke all on function public.start_exam(text,text,text,uuid) from public;
revoke all on function public.resume_exam(uuid,uuid) from public;
revoke all on function public.admin_unlock_attempt_session(uuid) from public;

grant execute on function public.start_exam(text,text,text,uuid) to anon, authenticated;
grant execute on function public.resume_exam(uuid,uuid) to anon, authenticated;
grant execute on function public.admin_unlock_attempt_session(uuid) to authenticated;
