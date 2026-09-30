-- Exam Guard: verified submission + 7-day recovery snapshots.
-- Additive upgrade. Safe to run while exams are active.
-- Existing attempts/responses are not modified.

create table if not exists public.attempt_recovery_snapshots (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  answered_count integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

create index if not exists attempt_recovery_snapshots_attempt_idx
  on public.attempt_recovery_snapshots(attempt_id, created_at desc);

create index if not exists attempt_recovery_snapshots_expiry_idx
  on public.attempt_recovery_snapshots(expires_at);

alter table public.attempt_recovery_snapshots enable row level security;

drop policy if exists teacher_attempt_recovery_snapshots_select on public.attempt_recovery_snapshots;
create policy teacher_attempt_recovery_snapshots_select
on public.attempt_recovery_snapshots
for select to authenticated
using (public.exam_guard_can_access_attempt(attempt_id));

revoke insert, update, delete on public.attempt_recovery_snapshots from anon, authenticated;
grant select on public.attempt_recovery_snapshots to authenticated;

create or replace function public.save_attempt_recovery_snapshot(
  p_attempt_token uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_answers jsonb := coalesce(p_answers, '{}'::jsonb);
  v_count integer := 0;
  v_id uuid;
  v_created timestamptz;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found then
    raise exception 'Invalid exam attempt.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Recovery snapshots can only be saved for an active attempt.';
  end if;

  if jsonb_typeof(v_answers) <> 'object' then
    raise exception 'Recovery snapshot answers must be a JSON object.';
  end if;

  select count(*) into v_count
  from jsonb_each_text(v_answers) x
  where btrim(coalesce(x.value,'')) <> '';

  insert into public.attempt_recovery_snapshots(
    attempt_id, answers, answered_count
  )
  values(
    v_attempt.id, v_answers, v_count
  )
  returning id, created_at into v_id, v_created;

  -- Keep at most the latest 5 snapshots per attempt.
  delete from public.attempt_recovery_snapshots s
  where s.attempt_id = v_attempt.id
    and s.id not in (
      select s2.id
      from public.attempt_recovery_snapshots s2
      where s2.attempt_id = v_attempt.id
      order by s2.created_at desc
      limit 5
    );

  return jsonb_build_object(
    'id', v_id,
    'created_at', v_created,
    'answered_count', v_count
  );
end;
$$;

revoke all on function public.save_attempt_recovery_snapshot(uuid,jsonb) from public;
grant execute on function public.save_attempt_recovery_snapshot(uuid,jsonb) to anon, authenticated;

create or replace function public.get_attempt_saved_response_state(
  p_attempt_token uuid
)
returns table(
  question_id uuid,
  answer text,
  saved_at timestamptz
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
    raise exception 'Exam attempt is not active.';
  end if;

  return query
  select r.question_id, r.answer, r.saved_at
  from public.responses r
  where r.attempt_id = v_attempt.id
  order by r.saved_at;
end;
$$;

revoke all on function public.get_attempt_saved_response_state(uuid) from public;
grant execute on function public.get_attempt_saved_response_state(uuid) to anon, authenticated;

create or replace function public.submit_exam_verified(
  p_attempt_token uuid,
  p_expected_nonblank integer
)
returns table(score numeric, max_score numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_saved_nonblank integer := 0;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found then
    raise exception 'Invalid exam attempt.';
  end if;

  if v_attempt.status = 'submitted' then
    return query select v_attempt.score, v_attempt.max_score;
    return;
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Exam attempt is not active.';
  end if;

  select count(*) into v_saved_nonblank
  from public.responses
  where attempt_id = v_attempt.id
    and btrim(coalesce(answer,'')) <> '';

  if v_saved_nonblank < greatest(coalesce(p_expected_nonblank,0),0) then
    raise exception
      'Submission verification failed: Supabase has % nonblank saved response(s), but the browser reports % answered item(s). Please retry saving before submission.',
      v_saved_nonblank,
      greatest(coalesce(p_expected_nonblank,0),0);
  end if;

  return query
  select * from public.submit_exam(p_attempt_token);
end;
$$;

revoke all on function public.submit_exam_verified(uuid,integer) from public;
grant execute on function public.submit_exam_verified(uuid,integer) to anon, authenticated;

create or replace function public.admin_get_attempt_recovery_snapshot(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.attempt_recovery_snapshots%rowtype;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  select * into v_row
  from public.attempt_recovery_snapshots
  where attempt_id = p_attempt_id
    and expires_at > now()
  order by created_at desc
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'answers', v_row.answers,
    'answered_count', v_row.answered_count,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at
  );
end;
$$;

revoke all on function public.admin_get_attempt_recovery_snapshot(uuid) from public;
grant execute on function public.admin_get_attempt_recovery_snapshot(uuid) to authenticated;
