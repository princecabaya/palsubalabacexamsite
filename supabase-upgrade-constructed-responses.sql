-- Constructed-response grading, short response, math solver, and exam sections.
-- Run once in Supabase SQL Editor.

alter table public.questions
  add column if not exists section_title text not null default 'Part 1';

alter table public.questions
  drop constraint if exists questions_question_type_check;

alter table public.questions
  add constraint questions_question_type_check
  check (question_type in ('mcq','binary','text','essay','short_response','math_solver'));

alter table public.responses
  add column if not exists provisional_score numeric(10,2),
  add column if not exists provisional_reason text,
  add column if not exists teacher_score numeric(10,2),
  add column if not exists teacher_comment text,
  add column if not exists review_status text not null default 'not_required',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

alter table public.responses
  drop constraint if exists responses_review_status_check;

alter table public.responses
  add constraint responses_review_status_check
  check (review_status in ('not_required','pending','approved'));

alter table public.attempts
  add column if not exists grading_status text not null default 'not_required',
  add column if not exists provisional_score numeric(10,2),
  add column if not exists provisional_max_score numeric(10,2),
  add column if not exists grading_approved_at timestamptz,
  add column if not exists grading_approved_by uuid references auth.users(id) on delete set null;

alter table public.attempts
  drop constraint if exists attempts_grading_status_check;

alter table public.attempts
  add constraint attempts_grading_status_check
  check (grading_status in ('not_required','pending_ai','pending_review','approved'));

drop function if exists public.get_exam_questions(uuid);

create function public.get_exam_questions(p_attempt_token uuid)
returns table(
  question_id uuid,
  "position" integer,
  section_title text,
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

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  if now() > v_attempt.started_at + make_interval(mins => v_exam.duration_minutes) then
    update public.attempts set status = 'expired' where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  return query
  select
    q.id,
    q.position as "position",
    q.section_title,
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

create or replace function public.submit_exam(p_attempt_token uuid)
returns table(score numeric, max_score numeric)
language plpgsql
security definer
set search_path = public
as $submit$
declare
  v_attempt public.attempts%rowtype;
  v_score numeric;
  v_auto_max numeric;
  v_has_constructed boolean;
begin
  select * into v_attempt from public.attempts where attempt_token = p_attempt_token;

  if not found then raise exception 'Invalid exam attempt.'; end if;

  if v_attempt.status = 'submitted' then
    return query select v_attempt.score, v_attempt.max_score;
    return;
  end if;

  select
    coalesce(sum(
      case
        when q.question_type in ('mcq','binary')
         and q.correct_answer is not null
         and lower(trim(coalesce(r.answer,''))) = lower(trim(q.correct_answer))
        then q.points else 0
      end
    ),0),
    coalesce(sum(case when q.question_type in ('mcq','binary') then q.points else 0 end),0),
    bool_or(q.question_type in ('essay','short_response','math_solver'))
  into v_score, v_auto_max, v_has_constructed
  from public.questions q
  left join public.responses r on r.question_id = q.id and r.attempt_id = v_attempt.id
  where q.exam_id = v_attempt.exam_id;

  update public.responses r
  set review_status = 'pending'
  from public.questions q
  where r.question_id = q.id
    and r.attempt_id = v_attempt.id
    and q.question_type in ('essay','short_response','math_solver');

  update public.attempts
  set status = 'submitted',
      submitted_at = now(),
      score = v_score,
      max_score = v_auto_max,
      grading_status = case when coalesce(v_has_constructed,false) then 'pending_ai' else 'approved' end,
      provisional_score = null,
      provisional_max_score = null
  where id = v_attempt.id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(v_attempt.id,'exam_submitted',jsonb_build_object('auto_score',v_score,'auto_max_score',v_auto_max,'constructed_review_required',coalesce(v_has_constructed,false)));

  return query select v_score, v_auto_max;
end;
$submit$;

create or replace function public.admin_get_grading_review(p_attempt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $review$
  select jsonb_build_object(
    'attempt_id', a.id,
    'student_name', s.full_name,
    'student_no', s.student_no,
    'exam_title', e.title,
    'grading_status', a.grading_status,
    'current_score', a.score,
    'current_max_score', a.max_score,
    'provisional_score', a.provisional_score,
    'provisional_max_score', a.provisional_max_score,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'question_id', q.id,
          'position', q.position,
          'section_title', q.section_title,
          'prompt', q.prompt,
          'question_type', q.question_type,
          'points', q.points,
          'reference_answer', q.correct_answer,
          'rubric_type', q.rubric_type,
          'rubric_criteria', q.rubric_criteria,
          'student_answer', coalesce(r.answer,''),
          'provisional_score', r.provisional_score,
          'provisional_reason', r.provisional_reason,
          'teacher_score', r.teacher_score,
          'teacher_comment', r.teacher_comment,
          'review_status', r.review_status
        ) order by q.position
      )
      from public.questions q
      left join public.responses r on r.question_id=q.id and r.attempt_id=a.id
      where q.exam_id=a.exam_id
        and q.question_type in ('essay','short_response','math_solver')
    ), '[]'::jsonb)
  )
  from public.attempts a
  join public.students s on s.id=a.student_id
  join public.exams e on e.id=a.exam_id
  where a.id=p_attempt_id
    and a.status='submitted'
    and public.exam_guard_can_access_attempt(a.id);
$review$;

create or replace function public.admin_approve_constructed_scores(
  p_attempt_id uuid,
  p_scores jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $approve$
declare
  v_item jsonb;
  v_question_id uuid;
  v_score numeric;
  v_comment text;
  v_auto_score numeric := 0;
  v_auto_max numeric := 0;
  v_constructed_score numeric := 0;
  v_constructed_max numeric := 0;
  v_total_score numeric := 0;
  v_total_max numeric := 0;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can approve constructed-response scores.';
  end if;

  if jsonb_typeof(p_scores) <> 'array' then
    raise exception 'Scores must be supplied as an array.';
  end if;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_question_id := (v_item->>'question_id')::uuid;
    v_score := (v_item->>'score')::numeric;
    v_comment := nullif(trim(coalesce(v_item->>'comment','')),'');

    if not exists(
      select 1 from public.questions q
      join public.attempts a on a.exam_id=q.exam_id
      where a.id=p_attempt_id
        and q.id=v_question_id
        and q.question_type in ('essay','short_response','math_solver')
        and v_score between 0 and q.points
    ) then
      raise exception 'Invalid score for question %.', v_question_id;
    end if;

    update public.responses
    set teacher_score=v_score,
        teacher_comment=v_comment,
        review_status='approved',
        reviewed_at=now(),
        reviewed_by=auth.uid()
    where attempt_id=p_attempt_id and question_id=v_question_id;
  end loop;

  select
    coalesce(sum(case when q.question_type in ('mcq','binary')
      and q.correct_answer is not null
      and lower(trim(coalesce(r.answer,'')))=lower(trim(q.correct_answer))
      then q.points else 0 end),0),
    coalesce(sum(case when q.question_type in ('mcq','binary') then q.points else 0 end),0),
    coalesce(sum(case when q.question_type in ('essay','short_response','math_solver') then coalesce(r.teacher_score,0) else 0 end),0),
    coalesce(sum(case when q.question_type in ('essay','short_response','math_solver') then q.points else 0 end),0)
  into v_auto_score,v_auto_max,v_constructed_score,v_constructed_max
  from public.questions q
  left join public.responses r on r.question_id=q.id and r.attempt_id=p_attempt_id
  join public.attempts a on a.exam_id=q.exam_id
  where a.id=p_attempt_id;

  v_total_score := v_auto_score + v_constructed_score;
  v_total_max := v_auto_max + v_constructed_max;

  update public.attempts
  set score=v_total_score,
      max_score=v_total_max,
      grading_status='approved',
      grading_approved_at=now(),
      grading_approved_by=auth.uid()
  where id=p_attempt_id;

  return jsonb_build_object('score',v_total_score,'max_score',v_total_max,'grading_status','approved');
end;
$approve$;

revoke all on function public.admin_get_grading_review(uuid) from public;
revoke all on function public.admin_approve_constructed_scores(uuid,jsonb) from public;
grant execute on function public.admin_get_grading_review(uuid) to authenticated;
grant execute on function public.admin_approve_constructed_scores(uuid,jsonb) to authenticated;


-- Result reports include provisional/teacher-reviewed constructed-response scores.
create or replace function public.exam_guard_build_attempt_report(p_attempt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $report$
  select jsonb_build_object(
    'attempt_id', a.id,
    'student_name', s.full_name,
    'student_no', s.student_no,
    'exam_title', e.title,
    'exam_code', e.code,
    'teacher_name', coalesce(nullif(ea.display_name,''), nullif(ea.email,''), 'Teacher'),
    'grading_status', a.grading_status,
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'score', case
      when a.grading_status in ('pending_ai','pending_review') and a.provisional_score is not null
        then a.provisional_score
      else a.score
    end,
    'max_score', case
      when a.grading_status in ('pending_ai','pending_review') and a.provisional_max_score is not null
        then a.provisional_max_score
      else a.max_score
    end,
    'percentage', case
      when a.grading_status in ('pending_ai','pending_review')
       and coalesce(a.provisional_max_score,0)>0
        then round((a.provisional_score/a.provisional_max_score)*100,2)
      when coalesce(a.max_score,0)>0
        then round((a.score/a.max_score)*100,2)
      else null
    end,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'position', q.position,
          'section_title', q.section_title,
          'prompt', q.prompt,
          'question_type', q.question_type,
          'student_answer', coalesce(r.answer,''),
          'correct_answer', q.correct_answer,
          'points', q.points,
          'provisional_reason', r.provisional_reason,
          'points_awarded', case
            when q.question_type in ('mcq','binary') then
              case when q.correct_answer is not null
                and lower(trim(coalesce(r.answer,'')))=lower(trim(q.correct_answer))
                then q.points else 0 end
            when a.grading_status='approved' then r.teacher_score
            else r.provisional_score
          end,
          'result', case
            when q.question_type in ('mcq','binary') then
              case when q.correct_answer is not null
                and lower(trim(coalesce(r.answer,'')))=lower(trim(q.correct_answer))
                then 'correct' else 'wrong' end
            when a.grading_status='approved' then 'approved'
            else 'pending_review'
          end
        ) order by q.position
      )
      from public.questions q
      left join public.responses r
        on r.question_id=q.id and r.attempt_id=a.id
      where q.exam_id=a.exam_id
    ), '[]'::jsonb)
  )
  from public.attempts a
  join public.students s on s.id=a.student_id
  join public.exams e on e.id=a.exam_id
  left join public.exam_admins ea on ea.user_id=e.owner_id
  where a.id=p_attempt_id and a.status='submitted';
$report$;

revoke all on function public.exam_guard_build_attempt_report(uuid) from public;

