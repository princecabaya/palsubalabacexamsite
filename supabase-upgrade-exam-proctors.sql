-- Exam-specific proctor access.
-- Run once in Supabase SQL Editor.
-- Proctors can view a published assigned exam and its attempts, and may Reset for Retake.
-- They cannot edit/draft/close/archive/delete the exam, edit questions, delete attempts,
-- or otherwise manage the exam.

create table if not exists public.exam_proctors (
  exam_id uuid not null references public.exams(id) on delete cascade,
  teacher_user_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (exam_id, teacher_user_id)
);

create index if not exists exam_proctors_teacher_idx
  on public.exam_proctors(teacher_user_id, exam_id);

alter table public.exam_proctors enable row level security;

-- True only while the assigned exam is published and the teacher account is enabled.
create or replace function public.exam_guard_is_exam_proctor(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $proctor$
  select exists(
    select 1
    from public.exam_proctors ep
    join public.exams e on e.id = ep.exam_id
    join public.exam_admins ea on ea.user_id = ep.teacher_user_id
    where ep.exam_id = p_exam_id
      and ep.teacher_user_id = auth.uid()
      and ea.is_admin = true
      and e.status = 'published'
      and coalesce(e.archived, false) = false
  );
$proctor$;

-- View access = owner/Main Admin OR published-exam proctor.
create or replace function public.exam_guard_can_view_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $view$
  select
    public.exam_guard_can_access_exam(p_exam_id)
    or public.exam_guard_is_exam_proctor(p_exam_id);
$view$;

create or replace function public.exam_guard_can_view_attempt(p_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $view$
  select exists(
    select 1
    from public.attempts a
    where a.id = p_attempt_id
      and public.exam_guard_can_view_exam(a.exam_id)
  );
$view$;

-- Assignment rows can be seen by Main Admin, the exam owner, or the assigned proctor.
drop policy if exists exam_proctors_select on public.exam_proctors;
create policy exam_proctors_select
on public.exam_proctors
for select to authenticated
using (
  teacher_user_id = auth.uid()
  or public.exam_guard_current_user_is_main_admin()
  or exists(
    select 1
    from public.exams e
    where e.id = exam_proctors.exam_id
      and e.owner_id = auth.uid()
      and public.exam_guard_current_user_is_admin()
  )
);

-- Assignment mutations are intentionally RPC-only.
revoke insert, update, delete on public.exam_proctors from authenticated;
grant select on public.exam_proctors to authenticated;

create or replace function public.get_proctor_candidates()
returns table(
  user_id uuid,
  email text,
  display_name text
)
language sql
stable
security definer
set search_path = public
as $proctor$
  select ea.user_id, ea.email, ea.display_name
  from public.exam_admins ea
  where public.exam_guard_current_user_is_admin()
    and ea.is_admin = true
    and ea.user_id <> auth.uid()
  order by coalesce(nullif(ea.display_name,''), ea.email), ea.email;
$proctor$;

create or replace function public.get_exam_proctor_assignments(p_exam_id uuid default null)
returns table(
  exam_id uuid,
  exam_title text,
  exam_code text,
  teacher_user_id uuid,
  teacher_email text,
  teacher_name text,
  assigned_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $proctor$
  select
    e.id,
    e.title,
    e.code,
    ep.teacher_user_id,
    ea.email,
    ea.display_name,
    ep.assigned_at
  from public.exam_proctors ep
  join public.exams e on e.id = ep.exam_id
  left join public.exam_admins ea on ea.user_id = ep.teacher_user_id
  where (p_exam_id is null or e.id = p_exam_id)
    and (
      public.exam_guard_current_user_is_main_admin()
      or (
        public.exam_guard_current_user_is_admin()
        and e.owner_id = auth.uid()
      )
      or ep.teacher_user_id = auth.uid()
    )
  order by e.created_at desc, coalesce(nullif(ea.display_name,''), ea.email);
$proctor$;

create or replace function public.assign_exam_proctor(
  p_exam_id uuid,
  p_teacher_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $proctor$
declare
  v_exam public.exams%rowtype;
begin
  if auth.uid() is null or not public.exam_guard_current_user_is_admin() then
    raise exception 'Teacher access required.';
  end if;

  select * into v_exam from public.exams where id = p_exam_id;
  if not found then raise exception 'Exam not found.'; end if;

  if not (
    public.exam_guard_current_user_is_main_admin()
    or v_exam.owner_id = auth.uid()
  ) then
    raise exception 'Only the exam owner or Main Admin can assign a proctor.';
  end if;

  if v_exam.status <> 'published' or coalesce(v_exam.archived, false) then
    raise exception 'Proctors can only be assigned to a published examination.';
  end if;

  if p_teacher_user_id = v_exam.owner_id then
    raise exception 'The exam owner does not need a proctor assignment.';
  end if;

  if not exists(
    select 1 from public.exam_admins
    where user_id = p_teacher_user_id and is_admin = true
  ) then
    raise exception 'Select an authorized teacher.';
  end if;

  insert into public.exam_proctors(exam_id, teacher_user_id, assigned_by)
  values(p_exam_id, p_teacher_user_id, auth.uid())
  on conflict(exam_id, teacher_user_id)
  do update set assigned_by = excluded.assigned_by, assigned_at = now();

  return true;
end;
$proctor$;

create or replace function public.remove_exam_proctor(
  p_exam_id uuid,
  p_teacher_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $proctor$
declare
  v_owner uuid;
  v_deleted integer := 0;
begin
  select owner_id into v_owner from public.exams where id = p_exam_id;
  if v_owner is null then raise exception 'Exam not found.'; end if;

  if not (
    public.exam_guard_current_user_is_main_admin()
    or (public.exam_guard_current_user_is_admin() and v_owner = auth.uid())
  ) then
    raise exception 'Only the exam owner or Main Admin can remove a proctor.';
  end if;

  delete from public.exam_proctors
  where exam_id = p_exam_id
    and teacher_user_id = p_teacher_user_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$proctor$;

revoke all on function public.get_proctor_candidates() from public;
revoke all on function public.get_exam_proctor_assignments(uuid) from public;
revoke all on function public.assign_exam_proctor(uuid,uuid) from public;
revoke all on function public.remove_exam_proctor(uuid,uuid) from public;
grant execute on function public.get_proctor_candidates() to authenticated;
grant execute on function public.get_exam_proctor_assignments(uuid) to authenticated;
grant execute on function public.assign_exam_proctor(uuid,uuid) to authenticated;
grant execute on function public.remove_exam_proctor(uuid,uuid) to authenticated;

-- Exams: published proctored exams are visible, but only owners/Main Admin retain write policies.
drop policy if exists admin_exams on public.exams;
create policy admin_exams on public.exams
for select to authenticated
using (public.exam_guard_can_view_exam(id));

-- Questions: keep owner/Main Admin management, add read-only proctor access.
drop policy if exists admin_questions on public.questions;
create policy admin_questions on public.questions
for all to authenticated
using (public.exam_guard_can_access_exam(exam_id))
with check (public.exam_guard_can_access_exam(exam_id));

drop policy if exists proctor_questions_select on public.questions;
create policy proctor_questions_select on public.questions
for select to authenticated
using (public.exam_guard_can_view_exam(exam_id));

-- Attempts: proctors may read, but direct deletion remains owner/Main Admin only.
drop policy if exists admin_attempts on public.attempts;
create policy admin_attempts on public.attempts
for select to authenticated
using (public.exam_guard_can_view_exam(exam_id));

drop policy if exists admin_attempts_delete on public.attempts;
create policy admin_attempts_delete on public.attempts
for delete to authenticated
using (public.exam_guard_can_access_exam(exam_id));

-- Saved responses and proctoring events are read-only for proctors.
drop policy if exists admin_responses on public.responses;
create policy admin_responses on public.responses
for select to authenticated
using (
  exists (
    select 1 from public.attempts a
    where a.id = responses.attempt_id
      and public.exam_guard_can_view_exam(a.exam_id)
  )
);

drop policy if exists admin_events on public.proctor_events;
create policy admin_events on public.proctor_events
for select to authenticated
using (
  exists (
    select 1 from public.attempts a
    where a.id = proctor_events.attempt_id
      and public.exam_guard_can_view_exam(a.exam_id)
  )
);

drop policy if exists teacher_proctor_photos_select on public.proctor_photos;
create policy teacher_proctor_photos_select
on public.proctor_photos
for select to authenticated
using (public.exam_guard_can_view_attempt(attempt_id));

-- Attempt reports are viewable by proctors of a currently published assigned exam.
create or replace function public.admin_get_attempt_report(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $report$
declare
  v_report jsonb;
begin
  if auth.uid() is null or not public.exam_guard_can_view_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  v_report := public.exam_guard_build_attempt_report(p_attempt_id);

  if v_report is null then
    raise exception 'Only submitted attempts have result reports.';
  end if;

  return v_report;
end;
$report$;

-- Reopen remains owner/Main Admin only.
create or replace function public.admin_reopen_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $reopen$
declare
  v_updated integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can reopen this attempt.';
  end if;

  update public.attempts
  set status = 'active',
      submitted_at = null,
      score = null,
      max_score = null
  where id = p_attempt_id
    and status = 'submitted';

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    insert into public.proctor_events(attempt_id, event_type, details)
    values (
      p_attempt_id,
      'attempt_reopened_by_teacher',
      jsonb_build_object('teacher_user_id', auth.uid(), 'reopened_at', now())
    );
  end if;

  return v_updated = 1;
end;
$reopen$;

-- Reset for Retake is the one recovery action explicitly allowed to a proctor.
create or replace function public.admin_reset_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $reset$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_view_attempt(p_attempt_id) then
    raise exception 'You do not have access to reset this exam attempt.';
  end if;

  delete from public.responses where attempt_id = p_attempt_id;
  delete from public.proctor_events where attempt_id = p_attempt_id;
  delete from public.proctor_photos where attempt_id = p_attempt_id;

  delete from public.attempts where id = p_attempt_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$reset$;
