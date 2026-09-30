-- Exam Guard: per-essay submission.
-- Additive upgrade. Safe to run while attempts are active.
-- Students may submit essay responses one by one before final exam submission.

alter table public.responses
  add column if not exists essay_submitted_at timestamptz;

create index if not exists responses_essay_submitted_idx
  on public.responses(attempt_id, essay_submitted_at)
  where essay_submitted_at is not null;

create or replace function public.submit_essay_response(
  p_attempt_token uuid,
  p_question_id uuid,
  p_answer text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_question public.questions%rowtype;
  v_existing public.responses%rowtype;
  v_text text := left(coalesce(p_answer,''), 20000);
  v_submitted_at timestamptz;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token
  for update;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now() > public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  select * into v_question
  from public.questions
  where id = p_question_id
    and exam_id = v_attempt.exam_id;

  if not found then
    raise exception 'Question does not belong to this exam.';
  end if;

  if v_question.question_type <> 'essay' then
    raise exception 'Only essay responses can be submitted individually.';
  end if;

  if btrim(v_text) = '' then
    raise exception 'Essay response cannot be blank.';
  end if;

  select * into v_existing
  from public.responses
  where attempt_id = v_attempt.id
    and question_id = p_question_id
  for update;

  if found and v_existing.essay_submitted_at is not null then
    return jsonb_build_object(
      'ok', true,
      'already_submitted', true,
      'submitted_at', v_existing.essay_submitted_at
    );
  end if;

  insert into public.responses(
    attempt_id,
    question_id,
    answer,
    saved_at,
    essay_submitted_at,
    teacher_recovered,
    teacher_recovered_by,
    teacher_recovered_at
  )
  values(
    v_attempt.id,
    p_question_id,
    v_text,
    now(),
    now(),
    false,
    null,
    null
  )
  on conflict(attempt_id,question_id)
  do update set
    answer = excluded.answer,
    saved_at = excluded.saved_at,
    essay_submitted_at = excluded.essay_submitted_at,
    teacher_recovered = false,
    teacher_recovered_by = null,
    teacher_recovered_at = null
  returning essay_submitted_at into v_submitted_at;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    v_attempt.id,
    'essay_response_submitted',
    jsonb_build_object(
      'question_id', p_question_id,
      'submitted_at', v_submitted_at
    )
  );

  return jsonb_build_object(
    'ok', true,
    'already_submitted', false,
    'submitted_at', v_submitted_at
  );
end;
$$;

revoke all on function public.submit_essay_response(uuid,uuid,text) from public;
grant execute on function public.submit_essay_response(uuid,uuid,text) to anon, authenticated;

-- Ordinary autosave cannot alter an essay after that essay was individually submitted.
create or replace function public.save_exam_response(
  p_attempt_token uuid,
  p_question_id uuid,
  p_answer text
)
returns void
language plpgsql
security definer
set search_path = public
as $save$
declare
  v_attempt public.attempts%rowtype;
  v_existing public.responses%rowtype;
  v_incoming text := left(coalesce(p_answer,''), 20000);
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now() > public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  if not exists(
    select 1
    from public.questions
    where id = p_question_id
      and exam_id = v_attempt.exam_id
  ) then
    raise exception 'Question does not belong to this exam.';
  end if;

  select * into v_existing
  from public.responses
  where attempt_id = v_attempt.id
    and question_id = p_question_id
  for update;

  -- Individually submitted essays are immutable until the teacher reopens/unlocks them.
  if found and v_existing.essay_submitted_at is not null then
    return;
  end if;

  -- Do not let an accidental blank student save erase a teacher recovery.
  if found
     and coalesce(v_existing.teacher_recovered,false) = true
     and btrim(coalesce(v_existing.answer,'')) <> ''
     and btrim(v_incoming) = '' then
    return;
  end if;

  insert into public.responses(
    attempt_id,
    question_id,
    answer,
    saved_at,
    teacher_recovered,
    teacher_recovered_by,
    teacher_recovered_at
  )
  values(
    v_attempt.id,
    p_question_id,
    v_incoming,
    now(),
    false,
    null,
    null
  )
  on conflict(attempt_id,question_id)
  do update set
    answer = excluded.answer,
    saved_at = now(),
    teacher_recovered = false,
    teacher_recovered_by = null,
    teacher_recovered_at = null;
end;
$save$;

revoke all on function public.save_exam_response(uuid,uuid,text) from public;
grant execute on function public.save_exam_response(uuid,uuid,text) to anon, authenticated;

-- Include per-essay submitted state whenever an active attempt is restored.
drop function if exists public.get_saved_exam_responses(uuid);

create function public.get_saved_exam_responses(p_attempt_token uuid)
returns table(
  question_id uuid,
  answer text,
  saved_at timestamptz,
  essay_submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $saved$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token = p_attempt_token;

  if not found or v_attempt.status <> 'active' then
    raise exception 'No active exam session was found.';
  end if;

  if now() > public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts
    set status = 'expired'
    where id = v_attempt.id;
    raise exception 'The saved exam session has expired.';
  end if;

  return query
  select r.question_id, r.answer, r.saved_at, r.essay_submitted_at
  from public.responses r
  where r.attempt_id = v_attempt.id
  order by r.saved_at;
end;
$saved$;

revoke all on function public.get_saved_exam_responses(uuid) from public;
grant execute on function public.get_saved_exam_responses(uuid) to anon, authenticated;
