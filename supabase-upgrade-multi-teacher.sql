-- Multi-teacher ownership and Main Admin support mode.
-- Run ONCE in Supabase SQL Editor on the existing Exam Guard project.
-- Main Admin: sir.princejobetroh@gmail.com
-- Existing students remain shared by all authorized teachers.
-- Existing exams are assigned to the Main Admin.

-- 1. Extend teacher profiles.
alter table public.exam_admins
  add column if not exists email text,
  add column if not exists display_name text,
  add column if not exists role text not null default 'teacher';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'exam_admins_role_check'
  ) then
    alter table public.exam_admins
      add constraint exam_admins_role_check
      check (role in ('main_admin','teacher'));
  end if;
end $$;

-- Backfill profile data from Supabase Auth.
update public.exam_admins ea
set email = coalesce(ea.email, u.email),
    display_name = coalesce(
      nullif(ea.display_name, ''),
      nullif(u.raw_user_meta_data->>'full_name', ''),
      split_part(coalesce(u.email,''), '@', 1)
    )
from auth.users u
where u.id = ea.user_id;

-- Make Sir Prince the Main Admin.
update public.exam_admins
set is_admin = true,
    role = 'main_admin',
    email = 'sir.princejobetroh@gmail.com',
    display_name = coalesce(nullif(display_name,''), 'Sir Prince Jobetroh N. Cabaya Cruz')
where lower(email) = 'sir.princejobetroh@gmail.com'
   or user_id in (
     select id from auth.users
     where lower(email) = 'sir.princejobetroh@gmail.com'
   );

-- Keep future Auth users mirrored into exam_admins.
create or replace function public.exam_guard_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $teacher$
begin
  insert into public.exam_admins(user_id, email, display_name, role, is_admin)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name',''),
      split_part(coalesce(new.email,''), '@', 1)
    ),
    case
      when lower(coalesce(new.email,'')) = 'sir.princejobetroh@gmail.com'
      then 'main_admin'
      else 'teacher'
    end,
    case
      when lower(coalesce(new.email,'')) = 'sir.princejobetroh@gmail.com'
      then true
      else false
    end
  )
  on conflict (user_id) do update
  set email = excluded.email,
      display_name = coalesce(public.exam_admins.display_name, excluded.display_name);

  return new;
end;
$teacher$;

-- 2. Give each exam an owner.
alter table public.exams
  add column if not exists owner_id uuid references auth.users(id) on delete restrict;

alter table public.exams
  alter column owner_id set default auth.uid();

-- Existing exams belong to the Main Admin.
update public.exams e
set owner_id = u.id
from auth.users u
where e.owner_id is null
  and lower(u.email) = 'sir.princejobetroh@gmail.com';

create index if not exists exams_owner_created_idx
  on public.exams(owner_id, created_at desc);

-- 3. Authorization helpers.
create or replace function public.exam_guard_current_user_is_main_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $auth$
  select exists(
    select 1
    from public.exam_admins
    where user_id = auth.uid()
      and is_admin = true
      and role = 'main_admin'
  );
$auth$;

create or replace function public.exam_guard_can_access_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $auth$
  select
    public.exam_guard_current_user_is_main_admin()
    or exists(
      select 1
      from public.exams e
      where e.id = p_exam_id
        and e.owner_id = auth.uid()
        and public.exam_guard_current_user_is_admin()
    );
$auth$;

create or replace function public.exam_guard_can_access_attempt(p_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $auth$
  select exists(
    select 1
    from public.attempts a
    where a.id = p_attempt_id
      and public.exam_guard_can_access_exam(a.exam_id)
  );
$auth$;

-- 4. Replace teacher/admin RLS policies.
-- Shared student roster: every authorized teacher uses the same Student IDs.
drop policy if exists admin_students on public.students;
create policy admin_students on public.students
for all to authenticated
using (public.exam_guard_current_user_is_admin())
with check (public.exam_guard_current_user_is_admin());

-- Exams: regular teachers only their own; Main Admin all teachers.
drop policy if exists admin_exams on public.exams;
create policy admin_exams on public.exams
for select to authenticated
using (
  public.exam_guard_current_user_is_main_admin()
  or (
    public.exam_guard_current_user_is_admin()
    and owner_id = auth.uid()
  )
);

drop policy if exists teacher_insert_exams on public.exams;
create policy teacher_insert_exams on public.exams
for insert to authenticated
with check (
  public.exam_guard_current_user_is_main_admin()
  or (
    public.exam_guard_current_user_is_admin()
    and owner_id = auth.uid()
  )
);

drop policy if exists teacher_update_exams on public.exams;
create policy teacher_update_exams on public.exams
for update to authenticated
using (
  public.exam_guard_current_user_is_main_admin()
  or (
    public.exam_guard_current_user_is_admin()
    and owner_id = auth.uid()
  )
)
with check (
  public.exam_guard_current_user_is_main_admin()
  or (
    public.exam_guard_current_user_is_admin()
    and owner_id = auth.uid()
  )
);

drop policy if exists teacher_delete_exams on public.exams;
create policy teacher_delete_exams on public.exams
for delete to authenticated
using (
  public.exam_guard_current_user_is_main_admin()
  or (
    public.exam_guard_current_user_is_admin()
    and owner_id = auth.uid()
  )
);

drop policy if exists admin_questions on public.questions;
create policy admin_questions on public.questions
for all to authenticated
using (public.exam_guard_can_access_exam(exam_id))
with check (public.exam_guard_can_access_exam(exam_id));

drop policy if exists admin_attempts on public.attempts;
create policy admin_attempts on public.attempts
for select to authenticated
using (public.exam_guard_can_access_exam(exam_id));

drop policy if exists admin_attempts_delete on public.attempts;
create policy admin_attempts_delete on public.attempts
for delete to authenticated
using (public.exam_guard_can_access_exam(exam_id));

drop policy if exists admin_responses on public.responses;
create policy admin_responses on public.responses
for select to authenticated
using (
  exists (
    select 1
    from public.attempts a
    where a.id = responses.attempt_id
      and public.exam_guard_can_access_exam(a.exam_id)
  )
);

drop policy if exists admin_events on public.proctor_events;
create policy admin_events on public.proctor_events
for select to authenticated
using (
  exists (
    select 1
    from public.attempts a
    where a.id = proctor_events.attempt_id
      and public.exam_guard_can_access_exam(a.exam_id)
  )
);

drop policy if exists own_exam_admin on public.exam_admins;
drop policy if exists main_admin_exam_admins on public.exam_admins;

create policy own_exam_admin on public.exam_admins
for select to authenticated
using (
  user_id = auth.uid()
  or public.exam_guard_current_user_is_main_admin()
);

create policy main_admin_exam_admins on public.exam_admins
for update to authenticated
using (public.exam_guard_current_user_is_main_admin())
with check (public.exam_guard_current_user_is_main_admin());

-- 5. Secure SECURITY DEFINER admin RPCs against cross-teacher access.
create or replace function public.admin_delete_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $admin$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  delete from public.attempts
  where id = p_attempt_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$admin$;

create or replace function public.admin_delete_exam(p_exam_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $admin$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_exam(p_exam_id) then
    raise exception 'You do not have access to this examination.';
  end if;

  delete from public.exams
  where id = p_exam_id;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$admin$;

create or replace function public.admin_get_attempt_report(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $report$
declare
  v_report jsonb;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  v_report := public.exam_guard_build_attempt_report(p_attempt_id);
  if v_report is null then
    raise exception 'Only submitted attempts have result reports.';
  end if;

  return v_report;
end;
$report$;

-- 6. Helper for the Main Admin teacher switcher.
create or replace function public.get_teacher_workspaces()
returns table(
  user_id uuid,
  email text,
  display_name text,
  role text,
  is_admin boolean
)
language sql
stable
security definer
set search_path = public
as $teachers$
  select
    ea.user_id,
    ea.email,
    ea.display_name,
    ea.role,
    ea.is_admin
  from public.exam_admins ea
  where ea.is_admin = true
    and (
      ea.user_id = auth.uid()
      or public.exam_guard_current_user_is_main_admin()
    )
  order by
    case when ea.user_id = auth.uid() then 0 else 1 end,
    coalesce(ea.display_name, ea.email, ea.user_id::text);
$teachers$;

revoke all on function public.get_teacher_workspaces() from public;
grant execute on function public.get_teacher_workspaces() to authenticated;

grant select on public.exam_admins to authenticated;

-- Optional check after running:
-- select user_id, email, display_name, role, is_admin from public.exam_admins;
-- select id, code, title, owner_id from public.exams order by created_at desc;
