-- Exam Guard: allow students to see only the objective score before full result release.
-- Correct/incorrect item status, student answers, and answer keys remain hidden until teacher release.

create or replace function public.get_student_exam_result(
  p_exam_code text,
  p_student_no text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $result$
declare
  v_attempt_id uuid;
  v_results_released boolean := false;
  v_attempt public.attempts%rowtype;
  v_exam public.exams%rowtype;
  v_student public.students%rowtype;
  v_report jsonb;
begin
  select a.id
  into v_attempt_id
  from public.attempts a
  join public.exams e on e.id = a.exam_id
  join public.students s on s.id = a.student_id
  where lower(trim(e.code)) = lower(trim(p_exam_code))
    and lower(regexp_replace(s.student_no, '[^a-zA-Z0-9]', '', 'g')) =
        lower(regexp_replace(p_student_no, '[^a-zA-Z0-9]', '', 'g'))
    and a.status = 'submitted'
  order by a.submitted_at desc nulls last, a.started_at desc
  limit 1;

  if v_attempt_id is null then
    raise exception 'No submitted exam result was found for this Exam Code and Student ID.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = v_attempt_id;

  select * into v_exam
  from public.exams
  where id = v_attempt.exam_id;

  select * into v_student
  from public.students
  where id = v_attempt.student_id;

  v_results_released := coalesce(v_exam.results_released, false);

  if not v_results_released then
    return jsonb_build_object(
      'attempt_id', v_attempt.id,
      'student_name', v_student.full_name,
      'student_no', v_student.student_no,
      'exam_title', v_exam.title,
      'exam_code', v_exam.code,
      'submitted_at', v_attempt.submitted_at,
      'score', v_attempt.score,
      'max_score', v_attempt.max_score,
      'percentage', case
        when coalesce(v_attempt.max_score, 0) > 0
        then round((v_attempt.score / v_attempt.max_score) * 100, 2)
        else null
      end,
      'results_released', false,
      'items', '[]'::jsonb
    );
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt.id);

  if v_report is null then
    raise exception 'Result report is not available.';
  end if;

  return v_report || jsonb_build_object('results_released', true);
end;
$result$;

revoke all on function public.get_student_exam_result(text,text) from public;
grant execute on function public.get_student_exam_result(text,text) to anon, authenticated;


create or replace function public.get_submitted_exam_report(p_attempt_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $report$
declare
  v_attempt public.attempts%rowtype;
  v_results_released boolean := false;
  v_report jsonb;
begin
  select a.*
  into v_attempt
  from public.attempts a
  where a.attempt_token = p_attempt_token
    and a.status = 'submitted';

  if v_attempt.id is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  select coalesce(e.results_released,false)
  into v_results_released
  from public.exams e
  where e.id = v_attempt.exam_id;

  if not v_results_released then
    raise exception 'The full item-by-item result is not yet released by your teacher.';
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt.id);

  if v_report is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  return v_report || jsonb_build_object('results_released', true);
end;
$report$;

revoke all on function public.get_submitted_exam_report(uuid) from public;
grant execute on function public.get_submitted_exam_report(uuid) to anon, authenticated;
