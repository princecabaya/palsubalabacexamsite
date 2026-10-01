-- Exam Guard: teacher-controlled student result release.
-- Safe additive upgrade while exams are active.
-- Results/correct answers are hidden by default until the teacher releases them.

alter table public.exams
  add column if not exists results_released boolean not null default false,
  add column if not exists results_released_at timestamptz,
  add column if not exists results_released_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_set_exam_results_released(
  p_exam_id uuid,
  p_released boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.exam_guard_can_access_exam(p_exam_id) then
    raise exception 'You do not have access to this examination.';
  end if;

  update public.exams
  set results_released = coalesce(p_released,false),
      results_released_at = case when coalesce(p_released,false) then now() else null end,
      results_released_by = case when coalesce(p_released,false) then auth.uid() else null end
  where id = p_exam_id;

  if not found then
    raise exception 'Exam not found.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'results_released', coalesce(p_released,false)
  );
end;
$$;

revoke all on function public.admin_set_exam_results_released(uuid,boolean) from public;
grant execute on function public.admin_set_exam_results_released(uuid,boolean) to authenticated;

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
  v_report jsonb;
begin
  select a.id, coalesce(e.results_released,false)
  into v_attempt_id, v_results_released
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

  if not v_results_released then
    raise exception 'Your result is not yet released by your teacher.';
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt_id);

  if v_report is null then
    raise exception 'Result report is not available.';
  end if;

  return v_report;
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
  v_attempt_id uuid;
  v_results_released boolean := false;
  v_report jsonb;
begin
  select a.id, coalesce(e.results_released,false)
  into v_attempt_id, v_results_released
  from public.attempts a
  join public.exams e on e.id = a.exam_id
  where a.attempt_token = p_attempt_token
    and a.status = 'submitted';

  if v_attempt_id is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  if not v_results_released then
    raise exception 'Your result is not yet released by your teacher.';
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt_id);

  if v_report is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  return v_report;
end;
$report$;

revoke all on function public.get_submitted_exam_report(uuid) from public;
grant execute on function public.get_submitted_exam_report(uuid) to anon, authenticated;
