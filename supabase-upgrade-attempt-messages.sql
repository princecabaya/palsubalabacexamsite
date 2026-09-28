-- Teacher-to-student attempt messages.
-- Run once in Supabase SQL Editor.

create table if not exists public.attempt_messages (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  sender_user_id uuid not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists attempt_messages_attempt_created_idx
  on public.attempt_messages(attempt_id, created_at desc);

alter table public.attempt_messages enable row level security;

-- Teachers/proctors with access to the attempt may read its message history.
drop policy if exists teacher_attempt_messages_select on public.attempt_messages;
create policy teacher_attempt_messages_select
on public.attempt_messages
for select to authenticated
using (public.exam_guard_can_access_attempt(attempt_id));

-- Writes go through a SECURITY DEFINER RPC so permissions and validation are centralized.
revoke insert, update, delete on public.attempt_messages from anon, authenticated;
grant select on public.attempt_messages to authenticated;

create or replace function public.admin_send_attempt_message(
  p_attempt_id uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $msg$
declare
  v_text text;
  v_attempt public.attempts%rowtype;
  v_id uuid;
  v_created timestamptz;
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
    raise exception 'You do not have permission to message this attempt.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Messages can only be sent while the exam attempt is active.';
  end if;

  v_text := btrim(coalesce(p_message, ''));
  if v_text = '' then
    raise exception 'Message cannot be empty.';
  end if;

  if char_length(v_text) > 300 then
    raise exception 'Message must be 300 characters or fewer.';
  end if;

  insert into public.attempt_messages(attempt_id, sender_user_id, message)
  values (p_attempt_id, auth.uid(), v_text)
  returning id, created_at into v_id, v_created;

  insert into public.proctor_events(attempt_id,event_type,details)
  values (
    p_attempt_id,
    'teacher_message_sent',
    jsonb_build_object('message_id',v_id,'message',v_text)
  );

  return jsonb_build_object(
    'id',v_id,
    'message',v_text,
    'created_at',v_created
  );
end;
$msg$;

revoke all on function public.admin_send_attempt_message(uuid,text) from public;
grant execute on function public.admin_send_attempt_message(uuid,text) to authenticated;

create or replace function public.get_attempt_messages(
  p_attempt_token uuid,
  p_after timestamptz default null
)
returns table(
  message_id uuid,
  message text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $student_messages$
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
  select m.id, m.message, m.created_at
  from public.attempt_messages m
  where m.attempt_id = v_attempt.id
    and (p_after is null or m.created_at > p_after)
  order by m.created_at asc
  limit 20;
end;
$student_messages$;

revoke all on function public.get_attempt_messages(uuid,timestamptz) from public;
grant execute on function public.get_attempt_messages(uuid,timestamptz) to anon, authenticated;
