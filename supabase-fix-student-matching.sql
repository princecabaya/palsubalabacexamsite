-- Fix student login matching for punctuation/spacing differences.
-- Run this once in Supabase SQL Editor.
-- This does not change existing student records.

create or replace function public.exam_guard_normalize_student_no(p_value text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(p_value,'')), '[^a-z0-9]', '', 'g');
$$;

create or replace function public.exam_guard_normalize_name(p_value text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(p_value,'')), '[^a-z0-9]', '', 'g');
$$;

create or replace function public.start_exam(
  p_exam_code text,
  p_student_no text,
  p_student_name text,
  p_user_agent text default null
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
as $$
declare
  v_exam public.exams%rowtype;
  v_student public.students%rowtype;
  v_attempt public.attempts%rowtype;
begin
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
  from public.students as s
  where public.exam_guard_normalize_student_no(s.student_no)
        = public.exam_guard_normalize_student_no(p_student_no)
    and public.exam_guard_normalize_name(s.full_name)
        = public.exam_guard_normalize_name(p_student_name)
    and s.active = true;

  if not found then
    raise exception 'Student number and full name do not match an active student record.';
  end if;

  select * into v_attempt
  from public.attempts
  where exam_id = v_exam.id and student_id = v_student.id;

  if found then
    if v_attempt.status = 'submitted' then
      raise exception 'This student has already submitted this exam.';
    end if;

    if now() > v_attempt.started_at + make_interval(mins => v_exam.duration_minutes) then
      update public.attempts
      set status = 'expired'
      where id = v_attempt.id;
      raise exception 'The existing exam attempt has expired.';
    end if;
  else
    insert into public.attempts(exam_id, student_id, user_agent)
    values(v_exam.id, v_student.id, left(p_user_agent, 2000))
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
$$;

revoke all on function public.start_exam(text,text,text,text) from public;
grant execute on function public.start_exam(text,text,text,text) to anon, authenticated;
