-- Exam Guard: safe recovery when reopening legacy submitted attempts
-- Automatic reconstruction proceeds only when the recovery answer multiset,
-- current choices, point total, and recorded submitted score can all be verified.
-- Ambiguous mappings abort instead of guessing.

CREATE OR REPLACE FUNCTION private.prepare_submitted_attempt_for_reopen(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.attempts%rowtype;
  v_snapshot_answers jsonb;
  v_question_count integer := 0;
  v_answer_count integer := 0;
  v_response_count integer := 0;
  v_existing_snapshot_count integer := 0;
  v_current_max numeric := 0;
  v_reconstructed_score numeric := 0;
  v_extra record;
  v_i integer;
  v_candidate_count integer;
  v_candidate_question uuid;
  v_deficit_key text;
  v_assigned_multiset jsonb;
  v_saved_multiset jsonb;
begin
  select * into v_attempt
  from public.attempts
  where id = p_attempt_id
  for update;

  if not found then
    raise exception 'Attempt not found.';
  end if;

  if v_attempt.status <> 'submitted' then
    raise exception 'Only submitted attempts can be prepared for reopening.';
  end if;

  select count(*) into v_existing_snapshot_count
  from public.attempt_question_snapshots s
  where s.attempt_id = p_attempt_id;

  if v_existing_snapshot_count > 0 then
    return jsonb_build_object(
      'ok', true,
      'source', 'attempt_snapshot',
      'restored_count', (
        select count(*) from public.attempt_question_snapshots s
        where s.attempt_id = p_attempt_id
          and btrim(coalesce(s.student_answer,'')) <> ''
      )
    );
  end if;

  select count(*) into v_response_count
  from public.responses r
  where r.attempt_id = p_attempt_id;

  if v_response_count > 0 then
    perform private.capture_attempt_question_snapshot(p_attempt_id);

    update public.attempt_question_snapshots s
    set student_answer = r.answer,
        answer_saved_at = r.saved_at,
        essay_submitted_at = r.essay_submitted_at,
        provisional_score = r.provisional_score,
        provisional_reason = r.provisional_reason,
        teacher_score = r.teacher_score,
        teacher_comment = r.teacher_comment,
        teacher_rubric_scores = r.teacher_rubric_scores,
        review_status = r.review_status,
        reviewed_at = r.reviewed_at,
        reviewed_by = r.reviewed_by
    from public.responses r
    where r.attempt_id = p_attempt_id
      and r.question_id = s.original_question_id
      and s.attempt_id = p_attempt_id;

    return jsonb_build_object(
      'ok', true,
      'source', 'responses',
      'restored_count', (
        select count(*) from public.attempt_question_snapshots s
        where s.attempt_id = p_attempt_id
          and btrim(coalesce(s.student_answer,'')) <> ''
      )
    );
  end if;

  select ars.answers
  into v_snapshot_answers
  from public.attempt_recovery_snapshots ars
  where ars.attempt_id = p_attempt_id
    and ars.expires_at >= now()
  order by ars.created_at desc
  limit 1;

  if v_snapshot_answers is null then
    raise exception 'This submitted attempt has no permanent saved responses and no unexpired recovery snapshot. Reopening it cannot safely restore the student answers.';
  end if;

  select count(*), coalesce(sum(q.points),0)
  into v_question_count, v_current_max
  from public.questions q
  where q.exam_id = v_attempt.exam_id;

  select count(*) into v_answer_count
  from jsonb_each_text(v_snapshot_answers) x
  where btrim(coalesce(x.value,'')) <> '';

  if v_question_count = 0 then
    raise exception 'The examination currently has no questions.';
  end if;

  if exists (
    select 1
    from public.questions q
    where q.exam_id = v_attempt.exam_id
      and q.question_type not in ('mcq','binary')
  ) then
    raise exception 'Legacy automatic recovery is limited to fully auto-scored multiple-choice/binary exams. Use the recovery snapshot for manual review.';
  end if;

  if v_answer_count <> v_question_count then
    raise exception 'Legacy recovery contains % answered item(s) for % current question(s). Automatic reopening was stopped to avoid assigning answers to the wrong items.',
      v_answer_count, v_question_count;
  end if;

  if v_attempt.max_score is null or v_current_max <> v_attempt.max_score then
    raise exception 'The current exam point total (%) no longer matches the submitted attempt total (%). Automatic reopening was stopped.',
      v_current_max, coalesce(v_attempt.max_score,0);
  end if;

  create temporary table if not exists pg_temp.legacy_assignment(
    question_id uuid primary key,
    position integer,
    correct_answer text,
    assigned_answer text
  ) on commit drop;
  truncate pg_temp.legacy_assignment;

  insert into pg_temp.legacy_assignment(question_id,position,correct_answer,assigned_answer)
  select q.id,q.position,q.correct_answer,q.correct_answer
  from public.questions q
  where q.exam_id = v_attempt.exam_id
  order by q.position;

  create temporary table if not exists pg_temp.legacy_saved_counts(
    answer_key text primary key,
    answer_text text,
    saved_count integer
  ) on commit drop;
  truncate pg_temp.legacy_saved_counts;

  insert into pg_temp.legacy_saved_counts(answer_key,answer_text,saved_count)
  select lower(btrim(x.value)), min(x.value), count(*)
  from jsonb_each_text(v_snapshot_answers) x
  where btrim(coalesce(x.value,'')) <> ''
  group by lower(btrim(x.value));

  create temporary table if not exists pg_temp.legacy_correct_counts(
    answer_key text primary key,
    correct_text text,
    correct_count integer
  ) on commit drop;
  truncate pg_temp.legacy_correct_counts;

  insert into pg_temp.legacy_correct_counts(answer_key,correct_text,correct_count)
  select lower(btrim(q.correct_answer)), min(q.correct_answer), count(*)
  from public.questions q
  where q.exam_id = v_attempt.exam_id
    and q.correct_answer is not null
  group by lower(btrim(q.correct_answer));

  create temporary table if not exists pg_temp.legacy_deficits(
    answer_key text primary key,
    remaining integer
  ) on commit drop;
  truncate pg_temp.legacy_deficits;

  insert into pg_temp.legacy_deficits(answer_key,remaining)
  select c.answer_key, c.correct_count - coalesce(s.saved_count,0)
  from pg_temp.legacy_correct_counts c
  left join pg_temp.legacy_saved_counts s using(answer_key)
  where c.correct_count > coalesce(s.saved_count,0);

  create temporary table if not exists pg_temp.legacy_extras(
    answer_key text primary key,
    answer_text text,
    remaining integer
  ) on commit drop;
  truncate pg_temp.legacy_extras;

  insert into pg_temp.legacy_extras(answer_key,answer_text,remaining)
  select s.answer_key, s.answer_text, s.saved_count - coalesce(c.correct_count,0)
  from pg_temp.legacy_saved_counts s
  left join pg_temp.legacy_correct_counts c using(answer_key)
  where s.saved_count > coalesce(c.correct_count,0);

  if (select coalesce(sum(remaining),0) from pg_temp.legacy_deficits)
     <> (select coalesce(sum(remaining),0) from pg_temp.legacy_extras) then
    raise exception 'The recovery snapshot answer distribution no longer matches the current exam. Automatic reopening was stopped.';
  end if;

  for v_extra in
    select * from pg_temp.legacy_extras order by answer_key
  loop
    for v_i in 1..v_extra.remaining
    loop
      select count(*), (array_agg(a.question_id))[1]
      into v_candidate_count, v_candidate_question
      from pg_temp.legacy_assignment a
      join pg_temp.legacy_deficits d
        on d.answer_key = lower(btrim(a.correct_answer))
       and d.remaining > 0
      join public.questions q on q.id = a.question_id
      where lower(btrim(a.assigned_answer)) = lower(btrim(a.correct_answer))
        and exists (
          select 1
          from jsonb_array_elements_text(coalesce(q.choices,'[]'::jsonb)) c(choice)
          where lower(btrim(c.choice)) = v_extra.answer_key
        );

      if v_candidate_count <> 1 then
        raise exception 'Recovery answer "%" matches % possible item(s). Automatic reopening was stopped rather than guess.',
          v_extra.answer_text, v_candidate_count;
      end if;

      select lower(btrim(a.correct_answer))
      into v_deficit_key
      from pg_temp.legacy_assignment a
      where a.question_id = v_candidate_question;

      update pg_temp.legacy_assignment
      set assigned_answer = v_extra.answer_text
      where question_id = v_candidate_question;

      update pg_temp.legacy_deficits
      set remaining = remaining - 1
      where answer_key = v_deficit_key;
    end loop;
  end loop;

  if exists (select 1 from pg_temp.legacy_deficits where remaining <> 0) then
    raise exception 'Recovery reconstruction left unresolved answer deficits. Automatic reopening was stopped.';
  end if;

  select jsonb_object_agg(answer_key,cnt order by answer_key)
  into v_assigned_multiset
  from (
    select lower(btrim(assigned_answer)) as answer_key, count(*) as cnt
    from pg_temp.legacy_assignment
    group by lower(btrim(assigned_answer))
  ) z;

  select jsonb_object_agg(answer_key,saved_count order by answer_key)
  into v_saved_multiset
  from pg_temp.legacy_saved_counts;

  if v_assigned_multiset is distinct from v_saved_multiset then
    raise exception 'Recovery reconstruction did not reproduce the saved answer set exactly. Automatic reopening was stopped.';
  end if;

  select coalesce(sum(q.points),0)
  into v_reconstructed_score
  from pg_temp.legacy_assignment a
  join public.questions q on q.id=a.question_id
  where regexp_replace(lower(btrim(coalesce(a.assigned_answer,''))), '\s+', ' ', 'g')
      = regexp_replace(lower(btrim(coalesce(a.correct_answer,''))), '\s+', ' ', 'g');

  if v_attempt.score is null or v_reconstructed_score <> v_attempt.score then
    raise exception 'Recovery reconstruction produces score %/% instead of the recorded %/%. Automatic reopening was stopped.',
      v_reconstructed_score, v_current_max, coalesce(v_attempt.score,0), coalesce(v_attempt.max_score,0);
  end if;

  insert into public.attempt_question_snapshots(
    attempt_id, original_question_id, exam_id, position, section_title,
    prompt, question_type, choices, correct_answer, points,
    rubric_type, rubric_criteria, stimulus_type, stimulus_payload,
    student_answer, answer_saved_at, captured_at
  )
  select
    p_attempt_id, q.id, q.exam_id, q.position, q.section_title,
    q.prompt, q.question_type, q.choices, q.correct_answer, q.points,
    q.rubric_type, q.rubric_criteria, q.stimulus_type, q.stimulus_payload,
    a.assigned_answer, now(), now()
  from public.questions q
  join pg_temp.legacy_assignment a on a.question_id=q.id
  where q.exam_id=v_attempt.exam_id
  order by q.position;

  insert into public.responses(
    attempt_id, question_id, answer, saved_at,
    teacher_recovered, teacher_recovered_by, teacher_recovered_at
  )
  select
    p_attempt_id, a.question_id, a.assigned_answer, now(),
    true, auth.uid(), now()
  from pg_temp.legacy_assignment a
  on conflict(attempt_id,question_id)
  do update set
    answer=excluded.answer,
    saved_at=excluded.saved_at,
    teacher_recovered=true,
    teacher_recovered_by=excluded.teacher_recovered_by,
    teacher_recovered_at=excluded.teacher_recovered_at;

  return jsonb_build_object(
    'ok', true,
    'source', 'recovery_snapshot_reconstructed',
    'restored_count', v_answer_count,
    'score_verified', true,
    'score', v_reconstructed_score,
    'max_score', v_current_max
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_permit_submitted_attempt_edit(p_attempt_id uuid, p_minutes integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.attempts%rowtype;
  v_until timestamptz;
  v_prepare jsonb;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can permit editing.';
  end if;

  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'Editing permission must be between 1 and 240 minutes.';
  end if;

  select * into v_attempt
  from public.attempts
  where id=p_attempt_id
  for update;

  if not found then raise exception 'Attempt not found.'; end if;
  if v_attempt.status<>'submitted' then
    raise exception 'Editing permission can only be granted to a submitted attempt.';
  end if;

  v_prepare := private.prepare_submitted_attempt_for_reopen(p_attempt_id);
  v_until := now()+make_interval(mins=>p_minutes);

  update public.attempts
  set status='active',
      submitted_at=null,
      score=null,
      max_score=null,
      provisional_score=null,
      provisional_max_score=null,
      grading_status='pending_review',
      edit_permitted_until=v_until,
      edit_permitted_by=auth.uid(),
      edit_permission_granted_at=now(),
      extended_until=greatest(coalesce(extended_until,'-infinity'::timestamptz),v_until),
      active_session_id=null,
      session_locked_at=null
  where id=p_attempt_id;

  update public.responses
  set essay_submitted_at=null
  where attempt_id=p_attempt_id and essay_submitted_at is not null;

  update public.attempt_question_snapshots
  set essay_submitted_at=null
  where attempt_id=p_attempt_id and essay_submitted_at is not null;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    p_attempt_id,
    'post_submission_edit_permitted',
    jsonb_build_object(
      'teacher_user_id',auth.uid(),
      'minutes',p_minutes,
      'permitted_until',v_until,
      'answers_preserved',true,
      'recovery_source',v_prepare->>'source',
      'restored_count',coalesce((v_prepare->>'restored_count')::integer,0)
    )
  );

  return jsonb_build_object(
    'ok',true,
    'minutes',p_minutes,
    'permitted_until',v_until,
    'answers_preserved',true,
    'recovery_source',v_prepare->>'source',
    'restored_count',coalesce((v_prepare->>'restored_count')::integer,0)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reopen_attempt(p_attempt_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_updated integer := 0;
  v_prepare jsonb;
begin
  if auth.uid() is null
     or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can reopen this attempt.';
  end if;

  v_prepare := private.prepare_submitted_attempt_for_reopen(p_attempt_id);

  update public.attempts
  set status='active',
      submitted_at=null,
      score=null,
      max_score=null,
      provisional_score=null,
      provisional_max_score=null,
      grading_status='pending_review',
      active_session_id=null,
      session_locked_at=null
  where id=p_attempt_id
    and status='submitted';

  get diagnostics v_updated = row_count;

  if v_updated=1 then
    update public.responses
    set essay_submitted_at=null
    where attempt_id=p_attempt_id and essay_submitted_at is not null;

    update public.attempt_question_snapshots
    set essay_submitted_at=null
    where attempt_id=p_attempt_id and essay_submitted_at is not null;

    insert into public.proctor_events(attempt_id,event_type,details)
    values(
      p_attempt_id,
      'attempt_reopened_by_teacher',
      jsonb_build_object(
        'teacher_user_id',auth.uid(),
        'reopened_at',now(),
        'answers_preserved',true,
        'recovery_source',v_prepare->>'source',
        'restored_count',coalesce((v_prepare->>'restored_count')::integer,0)
      )
    );
  end if;

  return v_updated=1;
end;
$function$;

revoke all on function private.prepare_submitted_attempt_for_reopen(uuid) from public, anon, authenticated;
revoke all on function public.admin_reopen_attempt(uuid) from public, anon;
grant execute on function public.admin_reopen_attempt(uuid) to authenticated;
revoke all on function public.admin_permit_submitted_attempt_edit(uuid,integer) from public, anon;
grant execute on function public.admin_permit_submitted_attempt_edit(uuid,integer) to authenticated;
