-- One-time upgrade for refresh-safe active exam recovery.
-- Run this in Supabase SQL Editor on your existing Exam Guard project.
-- It does not alter or delete existing exams, attempts, responses, or scores.


-- ---------- Active attempt recovery ----------
create or replace function public.resume_exam(p_attempt_token uuid)
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
  select * into v_attempt
  from public.attempts
  where attempts.attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'No active exam session was found.';
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;
  select * into v_student from public.students where id = v_attempt.student_id;

  v_ends_at := least(
    v_attempt.started_at + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.end_at, 'infinity'::timestamptz)
  );

  if now() > v_ends_at then
    update public.attempts
    set status = 'expired'
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

create or replace function public.get_saved_exam_responses(p_attempt_token uuid)
returns table(
  question_id uuid,
  answer text,
  saved_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $resume$
declare
  v_attempt public.attempts%rowtype;
  v_exam public.exams%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempts.attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'No active exam session was found.';
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  if now() > least(
    v_attempt.started_at + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.end_at, 'infinity'::timestamptz)
  ) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;

    raise exception 'The saved exam session has expired.';
  end if;

  return query
  select r.question_id, r.answer, r.saved_at
  from public.responses r
  where r.attempt_id = v_attempt.id
  order by r.saved_at;
end;
$resume$;

revoke all on function public.resume_exam(uuid) from public;
revoke all on function public.get_saved_exam_responses(uuid) from public;
grant execute on function public.resume_exam(uuid) to anon, authenticated;
grant execute on function public.get_saved_exam_responses(uuid) to anon, authenticated;

