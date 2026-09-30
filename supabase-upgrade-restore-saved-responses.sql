-- Exam Guard: teacher-triggered restoration of Supabase-saved answers to an active student browser.
-- Run once in Supabase SQL Editor.

alter table public.attempt_messages
  add column if not exists message_type text not null default 'message';

alter table public.attempt_messages
  drop constraint if exists attempt_messages_message_type_check;

alter table public.attempt_messages
  add constraint attempt_messages_message_type_check
  check (message_type in ('message','restore_saved_responses'));

create or replace function public.admin_restore_attempt_responses(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_id uuid;
  v_created timestamptz;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Teacher sign-in is required.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have permission to restore this attempt.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Saved answers can only be restored while the exam attempt is active.';
  end if;

  select count(*) into v_count
  from public.responses
  where attempt_id = p_attempt_id
    and btrim(coalesce(answer,'')) <> '';

  if v_count = 0 then
    raise exception 'There are no saved answers in Supabase for this attempt.';
  end if;

  insert into public.attempt_messages(attempt_id, sender_user_id, message, message_type)
  values (
    p_attempt_id,
    auth.uid(),
    'Your teacher restored saved answers from your exam attempt.',
    'restore_saved_responses'
  )
  returning id, created_at into v_id, v_created;

  insert into public.proctor_events(attempt_id,event_type,details)
  values (
    p_attempt_id,
    'teacher_restored_saved_responses',
    jsonb_build_object(
      'message_id', v_id,
      'saved_response_count', v_count,
      'teacher_user_id', auth.uid()
    )
  );

  return jsonb_build_object(
    'id', v_id,
    'created_at', v_created,
    'saved_response_count', v_count
  );
end;
$$;

revoke all on function public.admin_restore_attempt_responses(uuid) from public;
grant execute on function public.admin_restore_attempt_responses(uuid) to authenticated;

drop function if exists public.get_attempt_messages(uuid,timestamptz);

create function public.get_attempt_messages(
  p_attempt_token uuid,
  p_after timestamptz default null
)
returns table(
  message_id uuid,
  message text,
  created_at timestamptz,
  message_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found then
    raise exception 'Invalid exam attempt.';
  end if;

  if v_attempt.status <> 'active' then
    return;
  end if;

  return query
  select m.id, m.message, m.created_at, m.message_type
  from public.attempt_messages m
  where m.attempt_id = v_attempt.id
    and (p_after is null or m.created_at > p_after)
  order by m.created_at asc
  limit 20;
end;
$$;

revoke all on function public.get_attempt_messages(uuid,timestamptz) from public;
grant execute on function public.get_attempt_messages(uuid,timestamptz) to anon, authenticated;
