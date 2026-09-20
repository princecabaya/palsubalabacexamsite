-- Submitted exam result PDF support.
-- Run this once in Supabase SQL Editor.
-- It does not alter or delete exam records.


-- ---------- Submitted result report API ----------
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
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'score', a.score,
    'max_score', a.max_score,
    'percentage', case
      when coalesce(a.max_score, 0) > 0 then round((a.score / a.max_score) * 100, 2)
      else null
    end,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'position', q.position,
          'prompt', q.prompt,
          'question_type', q.question_type,
          'student_answer', coalesce(r.answer, ''),
          'correct_answer', q.correct_answer,
          'points', q.points,
          'points_awarded', case
            when q.correct_answer is not null
             and lower(trim(coalesce(r.answer,''))) = lower(trim(q.correct_answer))
            then q.points
            when q.correct_answer is null then null
            else 0
          end,
          'result', case
            when q.correct_answer is null then 'manual'
            when lower(trim(coalesce(r.answer,''))) = lower(trim(q.correct_answer)) then 'correct'
            else 'wrong'
          end
        )
        order by q.position
      )
      from public.questions q
      left join public.responses r
        on r.question_id = q.id
       and r.attempt_id = a.id
      where q.exam_id = a.exam_id
    ), '[]'::jsonb)
  )
  from public.attempts a
  join public.students s on s.id = a.student_id
  join public.exams e on e.id = a.exam_id
  where a.id = p_attempt_id
    and a.status = 'submitted';
$report$;

create or replace function public.get_submitted_exam_report(p_attempt_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $report$
declare
  v_attempt_id uuid;
  v_report jsonb;
begin
  select id into v_attempt_id
  from public.attempts
  where attempt_token = p_attempt_token
    and status = 'submitted';

  if v_attempt_id is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt_id);
  if v_report is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  return v_report;
end;
$report$;

create or replace function public.admin_get_attempt_report(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $report$
declare
  v_report jsonb;
begin
  if auth.uid() is null or not public.exam_guard_current_user_is_admin() then
    raise exception 'Administrator access required.';
  end if;

  v_report := public.exam_guard_build_attempt_report(p_attempt_id);
  if v_report is null then
    raise exception 'Only submitted attempts have result reports.';
  end if;

  return v_report;
end;
$report$;

revoke all on function public.exam_guard_build_attempt_report(uuid) from public;
revoke all on function public.get_submitted_exam_report(uuid) from public;
revoke all on function public.admin_get_attempt_report(uuid) from public;

grant execute on function public.get_submitted_exam_report(uuid) to anon, authenticated;
grant execute on function public.admin_get_attempt_report(uuid) to authenticated;


