-- Exam Guard: improved short-response auto-scoring
-- Supports teacher-defined aliases separated by /, |, or ;
-- Ignores capitalization, punctuation, and hyphen/spacing differences.
-- Allows at most one character difference for longer answers.
-- Short responses remain auto-scored and are excluded from essay/manual grading.

-- private.exam_guard_compact_short_text(p_value text)
CREATE OR REPLACE FUNCTION private.exam_guard_compact_short_text(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select regexp_replace(
    private.exam_guard_normalize_short_text(p_value),
    '\s+', '', 'g'
  );
$function$;

-- private.exam_guard_edit_distance_at_most_one(a text, b text)
CREATE OR REPLACE FUNCTION private.exam_guard_edit_distance_at_most_one(a text, b text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  x text := coalesce(a,'');
  y text := coalesce(b,'');
  lx integer := length(x);
  ly integer := length(y);
  i integer := 1;
  j integer := 1;
  edits integer := 0;
begin
  if x = y then return true; end if;
  if abs(lx-ly) > 1 then return false; end if;

  while i <= lx and j <= ly loop
    if substr(x,i,1)=substr(y,j,1) then
      i:=i+1; j:=j+1;
    else
      edits:=edits+1;
      if edits>1 then return false; end if;
      if lx>ly then
        i:=i+1;
      elsif ly>lx then
        j:=j+1;
      else
        i:=i+1; j:=j+1;
      end if;
    end if;
  end loop;

  if i<=lx or j<=ly then edits:=edits+1; end if;
  return edits<=1;
end;
$function$;

-- private.exam_guard_normalize_short_text(p_value text)
CREATE OR REPLACE FUNCTION private.exam_guard_normalize_short_text(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(p_value,'')), '[^[:alnum:]]+', ' ', 'g'),
      '\s+', ' ', 'g'
    )
  );
$function$;

-- private.exam_guard_short_response_matches(p_student_answer text, p_correct_answer text)
CREATE OR REPLACE FUNCTION private.exam_guard_short_response_matches(p_student_answer text, p_correct_answer text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_student_norm text := private.exam_guard_normalize_short_text(p_student_answer);
  v_student_compact text := private.exam_guard_compact_short_text(p_student_answer);
  v_alias text;
  v_alias_norm text;
  v_alias_compact text;
begin
  if v_student_norm='' or btrim(coalesce(p_correct_answer,''))='' then
    return false;
  end if;

  for v_alias in
    select value
    from regexp_split_to_table(coalesce(p_correct_answer,''), '\s*(?:/|\||;)\s*') as value
  loop
    v_alias_norm := private.exam_guard_normalize_short_text(v_alias);
    v_alias_compact := private.exam_guard_compact_short_text(v_alias);

    if v_alias_norm='' then continue; end if;

    if v_student_norm=v_alias_norm or v_student_compact=v_alias_compact then
      return true;
    end if;

    if length(v_student_compact)>=7
       and length(v_alias_compact)>=7
       and private.exam_guard_edit_distance_at_most_one(v_student_compact,v_alias_compact)
    then
      return true;
    end if;
  end loop;

  return false;
end;
$function$;

-- public.admin_approve_constructed_scores(p_attempt_id uuid, p_scores jsonb)
CREATE OR REPLACE FUNCTION public.admin_approve_constructed_scores(p_attempt_id uuid, p_scores jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item jsonb;
  v_question_id uuid;
  v_score numeric;
  v_comment text;
  v_rubric jsonb;
  v_expected_count integer := 0;
  v_received_count integer := 0;
  v_auto_score numeric := 0;
  v_auto_max numeric := 0;
  v_constructed_score numeric := 0;
  v_constructed_max numeric := 0;
  v_total_score numeric := 0;
  v_total_max numeric := 0;
  v_exam_id uuid;
begin
  if auth.uid() is null or not public.exam_guard_can_access_attempt(p_attempt_id) then
    raise exception 'Only the exam owner or Main Admin can approve constructed-response scores.';
  end if;

  if jsonb_typeof(p_scores) <> 'array' then
    raise exception 'Scores must be supplied as an array.';
  end if;

  select a.exam_id into v_exam_id
  from public.attempts a
  where a.id=p_attempt_id;

  select count(*) into v_expected_count
  from public.attempt_question_snapshots s
  where s.attempt_id=p_attempt_id
    and s.question_type in ('essay','text','math_solver');

  v_received_count := jsonb_array_length(p_scores);

  if v_expected_count=0 then
    raise exception 'This attempt has no constructed-response items to approve.';
  end if;

  if v_received_count<>v_expected_count then
    raise exception 'All constructed-response items must be reviewed before approval. Expected %, received %.',
      v_expected_count,v_received_count;
  end if;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_question_id := (v_item->>'question_id')::uuid;
    v_score := (v_item->>'score')::numeric;
    v_comment := nullif(trim(coalesce(v_item->>'comment','')),'');
    v_rubric := case when v_item ? 'rubric_scores' then v_item->'rubric_scores' else null end;

    if not exists(
      select 1
      from public.attempt_question_snapshots s
      where s.attempt_id=p_attempt_id
        and s.original_question_id=v_question_id
        and s.question_type in ('essay','text','math_solver')
        and v_score between 0 and s.points
    ) then
      raise exception 'Invalid score for question %.',v_question_id;
    end if;

    update public.attempt_question_snapshots
    set teacher_score=v_score,
        teacher_comment=v_comment,
        teacher_rubric_scores=v_rubric,
        review_status='approved',
        reviewed_at=now(),
        reviewed_by=auth.uid()
    where attempt_id=p_attempt_id
      and original_question_id=v_question_id;

    if exists (
      select 1 from public.questions q
      where q.id=v_question_id and q.exam_id=v_exam_id
    ) then
      insert into public.responses(
        attempt_id,question_id,answer,
        teacher_score,teacher_comment,teacher_rubric_scores,review_status,
        reviewed_at,reviewed_by,saved_at
      )
      select
        p_attempt_id,
        v_question_id,
        coalesce(s.student_answer,''),
        v_score,
        v_comment,
        v_rubric,
        'approved',
        now(),
        auth.uid(),
        coalesce(s.answer_saved_at,now())
      from public.attempt_question_snapshots s
      where s.attempt_id=p_attempt_id and s.original_question_id=v_question_id
      on conflict(attempt_id,question_id)
      do update set
        teacher_score=excluded.teacher_score,
        teacher_comment=excluded.teacher_comment,
        teacher_rubric_scores=excluded.teacher_rubric_scores,
        review_status='approved',
        reviewed_at=excluded.reviewed_at,
        reviewed_by=excluded.reviewed_by;
    end if;
  end loop;

  select
    coalesce(sum(case
      when s.question_type in ('mcq','binary')
       and s.correct_answer is not null
       and lower(trim(coalesce(s.student_answer,'')))=lower(trim(s.correct_answer))
      then s.points
      when s.question_type='short_response'
       and private.exam_guard_short_response_matches(s.student_answer,s.correct_answer)
      then s.points else 0 end),0),
    coalesce(sum(case when s.question_type in ('mcq','binary','short_response') then s.points else 0 end),0),
    coalesce(sum(case
      when s.question_type in ('essay','text','math_solver')
      then coalesce(s.teacher_score,0) else 0 end),0),
    coalesce(sum(case
      when s.question_type in ('essay','text','math_solver')
      then s.points else 0 end),0)
  into v_auto_score,v_auto_max,v_constructed_score,v_constructed_max
  from public.attempt_question_snapshots s
  where s.attempt_id=p_attempt_id;

  v_total_score := v_auto_score+v_constructed_score;
  v_total_max := v_auto_max+v_constructed_max;

  update public.attempts
  set score=v_total_score,
      max_score=v_total_max,
      grading_status='approved',
      grading_approved_at=now(),
      grading_approved_by=auth.uid()
  where id=p_attempt_id;

  return jsonb_build_object(
    'score',v_total_score,
    'max_score',v_total_max,
    'grading_status','approved'
  );
end;
$function$;

-- public.admin_get_grading_review(p_attempt_id uuid)
CREATE OR REPLACE FUNCTION public.admin_get_grading_review(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'attempt_id', a.id,
    'student_name', s.full_name,
    'student_no', s.student_no,
    'exam_title', e.title,
    'grading_status', a.grading_status,
    'current_score', a.score,
    'current_max_score', a.max_score,
    'provisional_score', a.provisional_score,
    'provisional_max_score', a.provisional_max_score,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'question_id', q.id,
          'position', q.position,
          'section_title', q.section_title,
          'prompt', q.prompt,
          'question_type', case when q.question_type='text' then 'essay' else q.question_type end,
          'points', q.points,
          'reference_answer', q.correct_answer,
          'rubric_type', q.rubric_type,
          'rubric_criteria', q.rubric_criteria,
          'student_answer', coalesce(r.answer,''),
          'provisional_score', r.provisional_score,
          'provisional_reason', r.provisional_reason,
          'teacher_score', r.teacher_score,
          'teacher_comment', r.teacher_comment,
          'teacher_rubric_scores', r.teacher_rubric_scores,
          'review_status', r.review_status
        ) order by q.position
      )
      from public.questions q
      left join public.responses r on r.question_id=q.id and r.attempt_id=a.id
      where q.exam_id=a.exam_id
        and q.question_type in ('essay','text','math_solver')
    ), '[]'::jsonb)
  )
  from public.attempts a
  join public.students s on s.id=a.student_id
  join public.exams e on e.id=a.exam_id
  where a.id=p_attempt_id
    and a.status='submitted'
    and public.exam_guard_can_access_attempt(a.id);
$function$;

-- public.exam_guard_build_attempt_report(p_attempt_id uuid)
CREATE OR REPLACE FUNCTION public.exam_guard_build_attempt_report(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_report jsonb;
begin
  if exists (
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id = p_attempt_id
  ) then
    select jsonb_build_object(
      'attempt_id', a.id,
      'student_name', st.full_name,
      'student_no', st.student_no,
      'exam_title', e.title,
      'exam_code', e.code,
      'teacher_name', coalesce(nullif(ea.display_name,''), nullif(ea.email,''), 'Teacher'),
      'grading_status', a.grading_status,
      'started_at', a.started_at,
      'submitted_at', a.submitted_at,
      'score', case
        when a.grading_status in ('pending_ai','pending_review') and a.provisional_score is not null
          then a.provisional_score
        else a.score
      end,
      'max_score', case
        when a.grading_status in ('pending_ai','pending_review') and a.provisional_max_score is not null
          then a.provisional_max_score
        else a.max_score
      end,
      'percentage', case
        when a.grading_status in ('pending_ai','pending_review')
         and coalesce(a.provisional_max_score,0)>0
          then round((a.provisional_score/a.provisional_max_score)*100,2)
        when coalesce(a.max_score,0)>0
          then round((a.score/a.max_score)*100,2)
        else null
      end,
      'items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'position', s.position,
            'section_title', s.section_title,
            'prompt', s.prompt,
            'question_type', s.question_type,
            'student_answer', coalesce(s.student_answer,''),
            'correct_answer', s.correct_answer,
            'points', s.points,
            'provisional_reason', s.provisional_reason,
            'points_awarded', case
              when s.question_type in ('mcq','binary') then
                case when s.correct_answer is not null
                  and regexp_replace(lower(btrim(coalesce(s.student_answer,''))), '\s+', ' ', 'g')
                      = regexp_replace(lower(btrim(s.correct_answer)), '\s+', ' ', 'g')
                  then s.points else 0 end
              when s.question_type='short_response' then
                case when private.exam_guard_short_response_matches(s.student_answer,s.correct_answer)
                  then s.points else 0 end
              when a.grading_status='approved' then s.teacher_score
              else s.provisional_score
            end,
            'result', case
              when s.question_type in ('mcq','binary') then
                case when s.correct_answer is not null
                  and regexp_replace(lower(btrim(coalesce(s.student_answer,''))), '\s+', ' ', 'g')
                      = regexp_replace(lower(btrim(s.correct_answer)), '\s+', ' ', 'g')
                  then 'correct' else 'wrong' end
              when s.question_type='short_response' then
                case when private.exam_guard_short_response_matches(s.student_answer,s.correct_answer)
                  then 'correct' else 'wrong' end
              when a.grading_status='approved' then 'approved'
              else 'pending_review'
            end
          )
          order by s.position
        )
        from public.attempt_question_snapshots s
        where s.attempt_id = a.id
      ), '[]'::jsonb)
    )
    into v_report
    from public.attempts a
    join public.students st on st.id = a.student_id
    join public.exams e on e.id = a.exam_id
    left join public.exam_admins ea on ea.user_id = e.owner_id
    where a.id = p_attempt_id
      and a.status = 'submitted';

    return v_report;
  end if;

  -- Legacy fallback for attempts created before historical snapshots existed.
  select jsonb_build_object(
    'attempt_id', a.id,
    'student_name', st.full_name,
    'student_no', st.student_no,
    'exam_title', e.title,
    'exam_code', e.code,
    'teacher_name', coalesce(nullif(ea.display_name,''), nullif(ea.email,''), 'Teacher'),
    'grading_status', a.grading_status,
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'score', case
      when a.grading_status in ('pending_ai','pending_review') and a.provisional_score is not null
        then a.provisional_score
      else a.score
    end,
    'max_score', case
      when a.grading_status in ('pending_ai','pending_review') and a.provisional_max_score is not null
        then a.provisional_max_score
      else a.max_score
    end,
    'percentage', case
      when a.grading_status in ('pending_ai','pending_review')
       and coalesce(a.provisional_max_score,0)>0
        then round((a.provisional_score/a.provisional_max_score)*100,2)
      when coalesce(a.max_score,0)>0
        then round((a.score/a.max_score)*100,2)
      else null
    end,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'position', q.position,
          'section_title', q.section_title,
          'prompt', q.prompt,
          'question_type', q.question_type,
          'student_answer', coalesce(r.answer,''),
          'correct_answer', q.correct_answer,
          'points', q.points,
          'provisional_reason', r.provisional_reason,
          'points_awarded', case
            when q.question_type in ('mcq','binary') then
              case when q.correct_answer is not null
                and regexp_replace(lower(btrim(coalesce(r.answer,''))), '\s+', ' ', 'g')
                    = regexp_replace(lower(btrim(q.correct_answer)), '\s+', ' ', 'g')
                then q.points else 0 end
            when q.question_type='short_response' then
              case when private.exam_guard_short_response_matches(r.answer,q.correct_answer)
                then q.points else 0 end
            when a.grading_status='approved' then r.teacher_score
            else r.provisional_score
          end,
          'result', case
            when q.question_type in ('mcq','binary') then
              case when q.correct_answer is not null
                and regexp_replace(lower(btrim(coalesce(r.answer,''))), '\s+', ' ', 'g')
                    = regexp_replace(lower(btrim(q.correct_answer)), '\s+', ' ', 'g')
                then 'correct' else 'wrong' end
            when q.question_type='short_response' then
              case when private.exam_guard_short_response_matches(r.answer,q.correct_answer)
                then 'correct' else 'wrong' end
            when a.grading_status='approved' then 'approved'
            else 'pending_review'
          end
        ) order by q.position
      )
      from public.questions q
      left join public.responses r
        on r.question_id=q.id and r.attempt_id=a.id
      where q.exam_id=a.exam_id
    ), '[]'::jsonb)
  )
  into v_report
  from public.attempts a
  join public.students st on st.id=a.student_id
  join public.exams e on e.id=a.exam_id
  left join public.exam_admins ea on ea.user_id=e.owner_id
  where a.id=p_attempt_id and a.status='submitted';

  return v_report;
end;
$function$;

-- public.submit_exam(p_attempt_token uuid)
CREATE OR REPLACE FUNCTION public.submit_exam(p_attempt_token uuid)
 RETURNS TABLE(score numeric, max_score numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.attempts%rowtype;
  v_score numeric;
  v_auto_max numeric;
  v_has_constructed boolean;
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

  if not exists (
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id = v_attempt.id
  ) then
    perform private.capture_attempt_question_snapshot(v_attempt.id);
  end if;

  select
    coalesce(sum(
      case
        when (
          s.question_type in ('mcq','binary')
          and s.correct_answer is not null
          and regexp_replace(lower(btrim(coalesce(s.student_answer,''))), '\s+', ' ', 'g')
              = regexp_replace(lower(btrim(s.correct_answer)), '\s+', ' ', 'g')
        ) or (
          s.question_type='short_response'
          and private.exam_guard_short_response_matches(s.student_answer,s.correct_answer)
        )
        then s.points
        else 0
      end
    ),0),
    coalesce(sum(
      case
        when s.question_type in ('mcq','binary','short_response')
        then s.points
        else 0
      end
    ),0),
    bool_or(s.question_type in ('essay','text','math_solver'))
  into v_score, v_auto_max, v_has_constructed
  from public.attempt_question_snapshots s
  where s.attempt_id = v_attempt.id;

  update public.responses r
  set review_status = 'pending'
  from public.attempt_question_snapshots s
  where r.attempt_id = v_attempt.id
    and r.question_id = s.original_question_id
    and s.attempt_id = v_attempt.id
    and s.question_type in ('essay','text','math_solver');

  update public.attempt_question_snapshots
  set review_status = case
    when question_type in ('essay','text','math_solver') then 'pending'
    else review_status
  end
  where attempt_id = v_attempt.id;

  update public.attempts
  set status = 'submitted',
      submitted_at = now(),
      score = v_score,
      max_score = v_auto_max,
      grading_status = case
        when coalesce(v_has_constructed,false) then 'pending_ai'
        else 'approved'
      end,
      provisional_score = null,
      provisional_max_score = null
  where id = v_attempt.id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    v_attempt.id,
    'exam_submitted',
    jsonb_build_object(
      'auto_score',v_score,
      'auto_max_score',v_auto_max,
      'constructed_review_required',coalesce(v_has_constructed,false),
      'question_snapshot_preserved',true
    )
  );

  return query select v_score, v_auto_max;
end;
$function$;

revoke all on function private.exam_guard_normalize_short_text(text) from public, anon, authenticated;
revoke all on function private.exam_guard_compact_short_text(text) from public, anon, authenticated;
revoke all on function private.exam_guard_edit_distance_at_most_one(text,text) from public, anon, authenticated;
revoke all on function private.exam_guard_short_response_matches(text,text) from public, anon, authenticated;

-- Key corrections/accepted variants identified in production.
update public.questions q
set correct_answer='Planning'
from public.exams e
where q.exam_id=e.id
  and e.code='ENTRE5'
  and q.position=61
  and q.question_type='short_response'
  and q.correct_answer='Plannin';

update public.questions q
set correct_answer='Sensorimotor Stage / Sensory motor stage'
from public.exams e
where q.exam_id=e.id
  and e.code='ED-2-FINAL-EXAM'
  and q.position=54
  and q.question_type='short_response'
  and q.correct_answer='Sensorimotor Stage';

update public.questions q
set correct_answer='Locomotor skills / Locomotor'
from public.exams e
where q.exam_id=e.id
  and e.code='ED-1-FINAL-EXAMINATION'
  and q.position=32
  and q.question_type='short_response'
  and q.correct_answer='Locomotor skills';

-- Keep active snapshots aligned with corrected live answer keys.
update public.attempt_question_snapshots s
set correct_answer=q.correct_answer
from public.questions q
join public.attempts a on a.exam_id=q.exam_id
where s.attempt_id=a.id
  and s.original_question_id=q.id
  and a.status='active'
  and q.question_type='short_response'
  and s.correct_answer is distinct from q.correct_answer;
