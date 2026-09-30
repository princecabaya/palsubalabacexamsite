-- Exam Guard: teacher-recovered answers that become part of the student's submission.
-- Safe additive upgrade while exams are active.
-- Teacher recovery only fills blank/missing responses.
-- A later blank student save cannot erase a teacher-recovered answer.
-- A later nonblank student answer may replace it.

alter table public.responses
  add column if not exists teacher_recovered boolean not null default false,
  add column if not exists teacher_recovered_by uuid references auth.users(id) on delete set null,
  add column if not exists teacher_recovered_at timestamptz;

create or replace function public.admin_save_recovered_response(
  p_attempt_id uuid,
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
  v_existing public.responses%rowtype;
  v_text text;
  v_saved_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Teacher sign-in is required.';
  end if;

  if not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'You do not have access to this attempt.';
  end if;

  select * into v_attempt
  from public.attempts
  where id = p_attempt_id;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if v_attempt.status <> 'active' then
    raise exception 'Teacher-recovered answers can only be saved while the attempt is active. Reopen the attempt first if it was already submitted.';
  end if;

  if not exists(
    select 1
    from public.questions
    where id = p_question_id
      and exam_id = v_attempt.exam_id
  ) then
    raise exception 'Question does not belong to this exam.';
  end if;

  v_text := left(coalesce(p_answer,''), 20000);
  if btrim(v_text) = '' then
    raise exception 'Recovered answer cannot be blank.';
  end if;

  select * into v_existing
  from public.responses
  where attempt_id = p_attempt_id
    and question_id = p_question_id
  for update;

  if found and btrim(coalesce(v_existing.answer,'')) <> '' then
    raise exception 'This item already has a nonblank student response. Teacher recovery will not overwrite it.';
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
    p_attempt_id,
    p_question_id,
    v_text,
    now(),
    true,
    auth.uid(),
    now()
  )
  on conflict(attempt_id,question_id)
  do update set
    answer = excluded.answer,
    saved_at = excluded.saved_at,
    teacher_recovered = true,
    teacher_recovered_by = excluded.teacher_recovered_by,
    teacher_recovered_at = excluded.teacher_recovered_at
  returning saved_at into v_saved_at;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'teacher_recovered_response_saved',
    jsonb_build_object(
      'question_id', p_question_id,
      'teacher_user_id', auth.uid(),
      'saved_at', v_saved_at
    )
  );

  return jsonb_build_object(
    'ok', true,
    'question_id', p_question_id,
    'saved_at', v_saved_at
  );
end;
$$;

revoke all on function public.admin_save_recovered_response(uuid,uuid,text) from public;
grant execute on function public.admin_save_recovered_response(uuid,uuid,text) to authenticated;

-- Protect teacher-recovered text from an accidental blank autosave/final save.
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
