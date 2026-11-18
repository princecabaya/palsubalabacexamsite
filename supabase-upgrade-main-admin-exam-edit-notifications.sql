-- Main Admin cross-teacher exam editing + teacher notifications.
-- Production migration applied 2026-11-18.
-- The dashboard already renders teacher notifications in the fixed left-side panel.
--
-- This migration enhances autosave_exam_draft so that:
-- 1) Main Admin may edit drafts in any authorized teacher workspace.
-- 2) Exam ownership stays with the teacher.
-- 3) The affected teacher receives an unread notification describing the changes.
-- 4) Anonymous callers cannot execute the draft-edit RPC.

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
  v_editor_name text;
  v_changes text[] := array[]::text[];
  v_old_title text;
  v_old_code text;
  v_old_duration integer;
  v_old_start timestamptz;
  v_old_end timestamptz;
  v_old_payload jsonb := '{}'::jsonb;
  v_is_existing boolean := p_exam_id is not null;
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

    v_old_title := v_exam.title;
    v_old_code := v_exam.code;
    v_old_duration := v_exam.duration_minutes;
    v_old_start := v_exam.start_at;
    v_old_end := v_exam.end_at;
    v_old_payload := coalesce(v_exam.draft_payload, '{}'::jsonb);

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

    if v_old_title is distinct from coalesce(v_title, v_old_title, 'Untitled Draft') then
      v_changes := array_append(v_changes, 'title');
    end if;
    if v_old_code is distinct from v_code then
      v_changes := array_append(v_changes, 'exam code');
    end if;
    if v_old_duration is distinct from v_duration then
      v_changes := array_append(v_changes, 'duration');
    end if;
    if v_old_start is distinct from v_start_at or v_old_end is distinct from v_end_at then
      v_changes := array_append(v_changes, 'exam schedule');
    end if;
    if coalesce(v_old_payload->'questions','[]'::jsonb)
       is distinct from coalesce(p_payload->'questions','[]'::jsonb) then
      v_changes := array_append(v_changes, 'questions/content');
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

  if public.exam_guard_current_user_is_main_admin()
     and v_exam.owner_id is not null
     and v_exam.owner_id <> auth.uid()
     and (not v_is_existing or cardinality(v_changes) > 0) then

    select coalesce(display_name, email, 'Main Admin')
      into v_editor_name
    from public.exam_admins
    where user_id = auth.uid();

    insert into public.teacher_exam_notifications(
      recipient_user_id, exam_id, editor_user_id, notification_type,
      message, created_at, updated_at, read_at
    )
    values(
      v_exam.owner_id,
      v_exam.id,
      auth.uid(),
      'main_admin_edit',
      case
        when not v_is_existing then
          coalesce(v_editor_name,'Main Admin') ||
          ' created a draft examination in your workspace: "' ||
          coalesce(v_exam.title,'Untitled Exam') || '" (' || coalesce(v_exam.code,'') || ').'
        else
          coalesce(v_editor_name,'Main Admin') ||
          ' edited your examination "' || coalesce(v_exam.title,'Untitled Exam') ||
          '" (' || coalesce(v_exam.code,'') || '). Changed: ' ||
          array_to_string(v_changes, ', ') || '.'
      end,
      v_now,
      v_now,
      null
    )
    on conflict (recipient_user_id, exam_id, notification_type)
    do update set
      editor_user_id = excluded.editor_user_id,
      message = excluded.message,
      updated_at = excluded.updated_at,
      read_at = null;
  end if;

  return query
  select v_exam.id, v_exam.code, v_exam.title, v_now;
end;
$draft$;

revoke all on function public.autosave_exam_draft(uuid,uuid,jsonb) from public;
revoke all on function public.autosave_exam_draft(uuid,uuid,jsonb) from anon;
grant execute on function public.autosave_exam_draft(uuid,uuid,jsonb) to authenticated;
