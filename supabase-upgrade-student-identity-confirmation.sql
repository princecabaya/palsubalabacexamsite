-- One-time upgrade: student identity confirmation before fullscreen/start.
-- Run in Supabase SQL Editor.


-- ---------- Student identity preview before exam start ----------
create or replace function public.preview_exam_identity(
  p_exam_code text,
  p_student_no text
)
returns table(
  exam_title text,
  student_name text,
  student_no text
)
language plpgsql
security definer
set search_path = public
as $identity$
declare
  v_exam public.exams%rowtype;
  v_student public.students%rowtype;
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
  from public.students s
  where public.exam_guard_normalize_student_no(s.student_no)
        = public.exam_guard_normalize_student_no(p_student_no)
    and s.active = true
  limit 1;

  if not found then
    raise exception 'Student ID does not match an active student record.';
  end if;

  return query
  select v_exam.title, v_student.full_name, v_student.student_no;
end;
$identity$;

revoke all on function public.preview_exam_identity(text,text) from public;
grant execute on function public.preview_exam_identity(text,text) to anon, authenticated;

