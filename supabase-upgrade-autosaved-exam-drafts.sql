-- Persistent autosaved exam drafts.
-- Run once in Supabase SQL Editor.
-- Drafts are owned by the selected teacher workspace and are never published automatically.

alter table public.exams
  add column if not exists draft_payload jsonb not null default '{}'::jsonb,
  add column if not exists draft_updated_at timestamptz;

-- Keep the Main Admin identity and teacher-workspace ownership helper current.
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
      (
        public.exam_guard_current_user_is_main_admin()
        and exists (
          select 1 from public.exam_admins target_teacher
          where target_teacher.user_id = p_owner_id
            and target_teacher.is_admin = true
        )
      )
      or
      (
        public.exam_guard_current_user_is_admin()
        and p_owner_id = auth.uid()
      )
    );
$auth$;

create or replace function public.autosave_exam_draft(
  p_exam_id uuid,
  p_owner_id uuid,
  p_payload jsonb
)
returns table(
  exam_id uuid,
  exam_code text,
  exam_title text,
  saved_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $draft$
declare
  v_exam public.exams%rowtype;
  v_title text;
  v_requested_code text;
  v_code text;
  v_duration integer;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Teacher sign-in is required.';
  end if;

  if p_owner_id is null then
    raise exception 'A teacher workspace is required.';
  end if;

  if not public.exam_guard_can_create_exam_for_owner(p_owner_id) then
    raise exception 'You do not have permission to save drafts in this teacher workspace.';
  end if;

  v_title := nullif(btrim(coalesce(p_payload->>'title','')), '');
  v_requested_code := upper(nullif(btrim(coalesce(p_payload->>'code','')), ''));
  v_duration := greatest(1, least(600, coalesce(nullif(p_payload->>'duration_minutes','')::integer, 60)));

  begin
    v_start_at := nullif(p_payload->>'start_at','')::timestamptz;
  exception when others then
    v_start_at := null;
  end;
  begin
    v_end_at := nullif(p_payload->>'end_at','')::timestamptz;
  exception when others then
    v_end_at := null;
  end;

  if p_exam_id is null then
    v_code := 'DRAFT-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));

    if v_requested_code is not null
       and v_requested_code ~ '^[A-Z0-9-]+$'
       and not exists (select 1 from public.exams e where upper(e.code)=v_requested_code) then
      v_code := v_requested_code;
    end if;

    insert into public.exams(
      code, title, duration_minutes, status, start_at, end_at,
      owner_id, draft_payload, draft_updated_at
    )
    values(
      v_code,
      coalesce(v_title, 'Untitled Draft'),
      v_duration,
      'draft',
      v_start_at,
      v_end_at,
      p_owner_id,
      coalesce(p_payload,'{}'::jsonb),
      v_now
    )
    returning * into v_exam;
  else
    select * into v_exam
    from public.exams
    where id = p_exam_id
    for update;

    if not found then
      raise exception 'The draft exam no longer exists.';
    end if;

    if v_exam.owner_id <> p_owner_id then
      raise exception 'This draft belongs to a different teacher workspace.';
    end if;

    if v_exam.status = 'published' then
      raise exception 'Published examinations cannot be autosaved as drafts.';
    end if;

    v_code := v_exam.code;
    if v_requested_code is not null
       and v_requested_code ~ '^[A-Z0-9-]+$'
       and (
         upper(v_requested_code)=upper(v_exam.code)
         or not exists (
           select 1 from public.exams e
           where upper(e.code)=v_requested_code and e.id<>v_exam.id
         )
       ) then
      v_code := v_requested_code;
    end if;

    update public.exams
    set code = v_code,
        title = coalesce(v_title, title, 'Untitled Draft'),
        duration_minutes = v_duration,
        status = 'draft',
        start_at = v_start_at,
        end_at = v_end_at,
        draft_payload = coalesce(p_payload,'{}'::jsonb),
        draft_updated_at = v_now
    where id = v_exam.id
    returning * into v_exam;
  end if;

  return query
  select v_exam.id, v_exam.code, v_exam.title, v_now;
end;
$draft$;

revoke all on function public.autosave_exam_draft(uuid,uuid,jsonb) from public;
grant execute on function public.autosave_exam_draft(uuid,uuid,jsonb) to authenticated;
