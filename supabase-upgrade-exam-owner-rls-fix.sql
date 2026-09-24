-- Exam ownership / RLS repair for Main Admin support workspaces.
-- Run once in Supabase SQL Editor.
-- This keeps regular teachers restricted to their own exams while allowing the Main Admin
-- to create and manage exams inside an authorized co-teacher's workspace.

-- 1) Ensure the known Main Admin account is represented correctly.
insert into public.exam_admins (user_id, email, display_name, role, is_admin)
select
  u.id,
  u.email,
  coalesce(nullif(u.raw_user_meta_data->>'full_name',''), split_part(coalesce(u.email,''),'@',1)),
  'main_admin',
  true
from auth.users u
where lower(coalesce(u.email,'')) = 'sir.princejobetroh@gmail.com'
on conflict (user_id) do update
set email = excluded.email,
    display_name = coalesce(nullif(public.exam_admins.display_name,''), excluded.display_name),
    role = 'main_admin',
    is_admin = true;

-- 2) Authorization helper for assigning exam ownership.
create or replace function public.exam_guard_can_create_exam_for_owner(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $auth$
  select
    auth.uid() is not null
    and p_owner_id is not null
    and (
      -- Main Admin may create for any currently authorized teacher.
      (
        public.exam_guard_current_user_is_main_admin()
        and exists (
          select 1
          from public.exam_admins target_teacher
          where target_teacher.user_id = p_owner_id
            and target_teacher.is_admin = true
        )
      )
      or
      -- Regular authorized teachers may create only for themselves.
      (
        public.exam_guard_current_user_is_admin()
        and p_owner_id = auth.uid()
      )
    );
$auth$;

-- 3) Rebuild exam write policies using the ownership helper.
drop policy if exists teacher_insert_exams on public.exams;
create policy teacher_insert_exams on public.exams
for insert to authenticated
with check (
  public.exam_guard_can_create_exam_for_owner(owner_id)
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
  public.exam_guard_can_create_exam_for_owner(owner_id)
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

-- 4) Keep question writes aligned with exam ownership.
drop policy if exists admin_questions on public.questions;
create policy admin_questions on public.questions
for all to authenticated
using (public.exam_guard_can_access_exam(exam_id))
with check (public.exam_guard_can_access_exam(exam_id));

-- 5) Ensure the active user's own exam rows can be returned after INSERT ... RETURNING.
-- Proctor visibility is preserved through exam_guard_can_view_exam().
drop policy if exists admin_exams on public.exams;
create policy admin_exams on public.exams
for select to authenticated
using (public.exam_guard_can_view_exam(id));

-- Optional verification query:
-- select auth.uid(), public.exam_guard_current_user_is_admin(),
--        public.exam_guard_current_user_is_main_admin();
