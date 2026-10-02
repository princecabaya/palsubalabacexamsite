-- Exam Guard: temporary teacher-requested live camera viewing using WebRTC signaling.
-- Supabase stores only temporary SDP signaling; the video stream itself is peer-to-peer.
-- Sessions automatically expire after 10 minutes and are not recorded by this feature.

create table if not exists public.live_camera_sessions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  teacher_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested','accepted','declined','connected','ended','expired','failed')),
  offer_sdp text not null,
  answer_sdp text,
  requested_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  updated_at timestamptz not null default now()
);

create index if not exists live_camera_sessions_attempt_idx
  on public.live_camera_sessions(attempt_id, requested_at desc);

alter table public.live_camera_sessions enable row level security;

-- No direct client table access. All access goes through narrowly scoped RPCs.
revoke all on public.live_camera_sessions from anon, authenticated;

create or replace function public.admin_request_live_camera(
  p_attempt_id uuid,
  p_offer_sdp text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_id uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can request live camera viewing.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Live camera can only be requested for an active attempt.';
  end if;

  if btrim(coalesce(p_offer_sdp,'')) = '' then
    raise exception 'WebRTC offer is required.';
  end if;

  -- End any earlier open request for this attempt.
  update public.live_camera_sessions
  set status = 'ended',
      ended_at = now(),
      updated_at = now()
  where attempt_id = p_attempt_id
    and status in ('requested','accepted','connected');

  insert into public.live_camera_sessions(
    attempt_id,teacher_user_id,status,offer_sdp
  )
  values(
    p_attempt_id,auth.uid(),'requested',p_offer_sdp
  )
  returning id,expires_at into v_id,v_expires;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'live_camera_requested',
    jsonb_build_object(
      'session_id',v_id,
      'teacher_user_id',auth.uid(),
      'expires_at',v_expires
    )
  );

  return jsonb_build_object(
    'id',v_id,
    'status','requested',
    'expires_at',v_expires
  );
end;
$$;

create or replace function public.admin_get_live_camera_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.live_camera_sessions%rowtype;
begin
  select * into v
  from public.live_camera_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Live camera session not found.';
  end if;

  if auth.uid() is null
     or v.teacher_user_id <> auth.uid()
     or not public.exam_guard_can_access_attempt(v.attempt_id) then
    raise exception 'You do not have access to this live camera session.';
  end if;

  if v.expires_at <= now() and v.status in ('requested','accepted','connected') then
    update public.live_camera_sessions
    set status='expired',ended_at=now(),updated_at=now()
    where id=v.id;
    v.status := 'expired';
  end if;

  return jsonb_build_object(
    'id',v.id,
    'attempt_id',v.attempt_id,
    'status',v.status,
    'answer_sdp',v.answer_sdp,
    'requested_at',v.requested_at,
    'answered_at',v.answered_at,
    'expires_at',v.expires_at,
    'ended_at',v.ended_at
  );
end;
$$;

create or replace function public.admin_mark_live_camera_connected(
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.live_camera_sessions%rowtype;
begin
  select * into v from public.live_camera_sessions where id=p_session_id;
  if not found then return false; end if;

  if auth.uid() is null
     or v.teacher_user_id <> auth.uid()
     or not public.exam_guard_can_access_attempt(v.attempt_id) then
    raise exception 'You do not have access to this live camera session.';
  end if;

  update public.live_camera_sessions
  set status='connected',updated_at=now()
  where id=p_session_id and status='accepted';

  return found;
end;
$$;

create or replace function public.admin_end_live_camera(
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.live_camera_sessions%rowtype;
begin
  select * into v from public.live_camera_sessions where id=p_session_id;
  if not found then return false; end if;

  if auth.uid() is null
     or v.teacher_user_id <> auth.uid()
     or not public.exam_guard_can_access_attempt(v.attempt_id) then
    raise exception 'You do not have access to this live camera session.';
  end if;

  update public.live_camera_sessions
  set status='ended',ended_at=now(),updated_at=now()
  where id=p_session_id
    and status in ('requested','accepted','connected');

  if found then
    insert into public.proctor_events(attempt_id,event_type,details)
    values(
      v.attempt_id,
      'live_camera_ended',
      jsonb_build_object('session_id',p_session_id,'teacher_user_id',auth.uid())
    );
  end if;

  return found;
end;
$$;

create or replace function public.student_get_live_camera_request(
  p_attempt_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v public.live_camera_sessions%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token
    and status='active';

  if not found then
    return null;
  end if;

  select * into v
  from public.live_camera_sessions
  where attempt_id=v_attempt.id
    and status in ('requested','accepted','connected')
  order by requested_at desc
  limit 1;

  if not found then return null; end if;

  if v.expires_at <= now() then
    update public.live_camera_sessions
    set status='expired',ended_at=now(),updated_at=now()
    where id=v.id;
    return null;
  end if;

  return jsonb_build_object(
    'id',v.id,
    'status',v.status,
    'offer_sdp',case when v.status='requested' then v.offer_sdp else null end,
    'requested_at',v.requested_at,
    'expires_at',v.expires_at
  );
end;
$$;

create or replace function public.student_answer_live_camera(
  p_attempt_token uuid,
  p_session_id uuid,
  p_answer_sdp text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v public.live_camera_sessions%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token
    and status='active';

  if not found then
    raise exception 'Active exam attempt not found.';
  end if;

  select * into v
  from public.live_camera_sessions
  where id=p_session_id
    and attempt_id=v_attempt.id
  for update;

  if not found then
    raise exception 'Live camera request not found.';
  end if;

  if v.status <> 'requested' or v.expires_at <= now() then
    raise exception 'This live camera request is no longer active.';
  end if;

  if btrim(coalesce(p_answer_sdp,''))='' then
    raise exception 'WebRTC answer is required.';
  end if;

  update public.live_camera_sessions
  set status='accepted',
      answer_sdp=p_answer_sdp,
      answered_at=now(),
      updated_at=now()
  where id=p_session_id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    v_attempt.id,
    'live_camera_accepted',
    jsonb_build_object('session_id',p_session_id)
  );

  return jsonb_build_object('ok',true,'status','accepted');
end;
$$;

create or replace function public.student_decline_live_camera(
  p_attempt_token uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token
    and status='active';

  if not found then return false; end if;

  update public.live_camera_sessions
  set status='declined',answered_at=now(),ended_at=now(),updated_at=now()
  where id=p_session_id
    and attempt_id=v_attempt.id
    and status='requested';

  if found then
    insert into public.proctor_events(attempt_id,event_type,details)
    values(
      v_attempt.id,
      'live_camera_declined',
      jsonb_build_object('session_id',p_session_id)
    );
  end if;

  return found;
end;
$$;

revoke all on function public.admin_request_live_camera(uuid,text) from public;
revoke all on function public.admin_get_live_camera_session(uuid) from public;
revoke all on function public.admin_mark_live_camera_connected(uuid) from public;
revoke all on function public.admin_end_live_camera(uuid) from public;
revoke all on function public.student_get_live_camera_request(uuid) from public;
revoke all on function public.student_answer_live_camera(uuid,uuid,text) from public;
revoke all on function public.student_decline_live_camera(uuid,uuid) from public;

grant execute on function public.admin_request_live_camera(uuid,text) to authenticated;
grant execute on function public.admin_get_live_camera_session(uuid) to authenticated;
grant execute on function public.admin_mark_live_camera_connected(uuid) to authenticated;
grant execute on function public.admin_end_live_camera(uuid) to authenticated;
grant execute on function public.student_get_live_camera_request(uuid) to anon, authenticated;
grant execute on function public.student_answer_live_camera(uuid,uuid,text) to anon, authenticated;
grant execute on function public.student_decline_live_camera(uuid,uuid) to anon, authenticated;
