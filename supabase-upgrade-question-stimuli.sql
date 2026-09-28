-- Question stimulus support: image, function graph, or LaTeX.
-- Run once in Supabase SQL Editor.

alter table public.questions
  add column if not exists stimulus_type text not null default 'none',
  add column if not exists stimulus_payload jsonb not null default '{}'::jsonb;

alter table public.questions
  drop constraint if exists questions_stimulus_type_check;

alter table public.questions
  add constraint questions_stimulus_type_check
  check (stimulus_type in ('none','image','graph','latex'));

-- Public-read bucket: exam questions must be viewable by anonymous students.
-- Only authenticated authorized teachers may write objects.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values (
  'exam-stimuli',
  'exam-stimuli',
  true,
  5000000,
  array['image/png','image/jpeg','image/webp']::text[]
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists exam_stimuli_teacher_insert on storage.objects;
create policy exam_stimuli_teacher_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'exam-stimuli'
  and public.exam_guard_current_user_is_admin()
  and (
    public.exam_guard_current_user_is_main_admin()
    or split_part(name,'/',1) = auth.uid()::text
  )
);

drop policy if exists exam_stimuli_teacher_update on storage.objects;
create policy exam_stimuli_teacher_update
on storage.objects
for update to authenticated
using (
  bucket_id = 'exam-stimuli'
  and public.exam_guard_current_user_is_admin()
  and (
    public.exam_guard_current_user_is_main_admin()
    or split_part(name,'/',1) = auth.uid()::text
  )
)
with check (
  bucket_id = 'exam-stimuli'
  and public.exam_guard_current_user_is_admin()
  and (
    public.exam_guard_current_user_is_main_admin()
    or split_part(name,'/',1) = auth.uid()::text
  )
);

drop policy if exists exam_stimuli_teacher_delete on storage.objects;
create policy exam_stimuli_teacher_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'exam-stimuli'
  and public.exam_guard_current_user_is_admin()
  and (
    public.exam_guard_current_user_is_main_admin()
    or split_part(name,'/',1) = auth.uid()::text
  )
);

-- Student question API now returns stimulus metadata.
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
  v_exam public.exams%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  select * into v_exam from public.exams where id = v_attempt.exam_id;

  if now() > least(
    v_attempt.started_at + make_interval(mins => v_exam.duration_minutes),
    coalesce(v_exam.end_at, 'infinity'::timestamptz)
  ) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;
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
    q.rubric_criteria,
    q.stimulus_type,
    q.stimulus_payload
  from public.questions q
  where q.exam_id = v_attempt.exam_id
  order by q.position;
end;
$questions$;

revoke all on function public.get_exam_questions(uuid) from public;
grant execute on function public.get_exam_questions(uuid) to anon, authenticated;
