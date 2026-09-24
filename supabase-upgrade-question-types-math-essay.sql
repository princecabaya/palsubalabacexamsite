-- Mathematics display, Binary Response, and criteria-based Essay questions.
-- Run once in Supabase SQL Editor.

alter table public.questions
  add column if not exists rubric_criteria jsonb not null default '[]'::jsonb;

alter table public.questions
  drop constraint if exists questions_question_type_check;

alter table public.questions
  add constraint questions_question_type_check
  check (question_type in ('mcq','binary','text','essay'));

-- Return rubric metadata with active exam questions. Students still do not receive
-- answer keys through this RPC.
drop function if exists public.get_exam_questions(uuid);

create function public.get_exam_questions(p_attempt_token uuid)
returns table(
  question_id uuid,
  "position" integer,
  prompt text,
  question_type text,
  choices jsonb,
  points numeric,
  rubric_criteria jsonb
)
language plpgsql
security definer
set search_path = public
as $questions$
declare
  v_attempt public.attempts%rowtype;
  v_exam public.exams%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  select * into v_exam
  from public.exams
  where id = v_attempt.exam_id;

  if now() > v_attempt.started_at + make_interval(mins => v_exam.duration_minutes) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  return query
  select
    q.id,
    q.position as "position",
    q.prompt,
    q.question_type,
    q.choices,
    q.points,
    q.rubric_criteria
  from public.questions q
  where q.exam_id = v_attempt.exam_id
  order by q.position;
end;
$questions$;

revoke all on function public.get_exam_questions(uuid) from public;
grant execute on function public.get_exam_questions(uuid) to anon, authenticated;


-- Rubric type for essay questions.
alter table public.questions
  add column if not exists rubric_type text not null default 'analytic';

alter table public.questions
  drop constraint if exists questions_rubric_type_check;

alter table public.questions
  add constraint questions_rubric_type_check
  check (rubric_type in ('analytic','holistic'));

drop function if exists public.get_exam_questions(uuid);

create function public.get_exam_questions(p_attempt_token uuid)
returns table(
  question_id uuid,
  "position" integer,
  prompt text,
  question_type text,
  choices jsonb,
  points numeric,
  rubric_type text,
  rubric_criteria jsonb
)
language plpgsql
security definer
set search_path = public
as $questions$
declare
  v_attempt public.attempts%rowtype;
  v_exam public.exams%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  select * into v_exam
  from public.exams
  where id = v_attempt.exam_id;

  if now() > v_attempt.started_at + make_interval(mins => v_exam.duration_minutes) then
    update public.attempts set status = 'expired' where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  return query
  select
    q.id,
    q.position as "position",
    q.prompt,
    q.question_type,
    q.choices,
    q.points,
    q.rubric_type,
    q.rubric_criteria
  from public.questions q
  where q.exam_id = v_attempt.exam_id
  order by q.position;
end;
$questions$;

revoke all on function public.get_exam_questions(uuid) from public;
grant execute on function public.get_exam_questions(uuid) to anon, authenticated;

