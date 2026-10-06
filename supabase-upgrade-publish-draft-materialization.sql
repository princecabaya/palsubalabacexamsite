-- Exam Guard: publish the latest autosaved draft atomically.
-- Converts exams.draft_payload.questions into public.questions before status becomes published.

create or replace function public.admin_publish_exam_from_draft(
  p_exam_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_payload jsonb;
  v_questions jsonb;
  v_count integer := 0;
  v_q jsonb;
  v_position integer := 0;
  v_question_type text;
  v_points numeric;
  v_prompt text;
begin
  if auth.uid() is null or not public.exam_guard_can_access_exam(p_exam_id) then
    raise exception 'You do not have permission to publish this examination.';
  end if;

  select * into v_exam
  from public.exams
  where id = p_exam_id
  for update;

  if not found then
    raise exception 'Exam not found.';
  end if;

  if coalesce(v_exam.archived,false) then
    raise exception 'Archived examinations cannot be published.';
  end if;

  v_payload := coalesce(v_exam.draft_payload, '{}'::jsonb);
  v_questions := v_payload->'questions';

  if jsonb_typeof(v_questions) = 'array' and jsonb_array_length(v_questions) > 0 then
    delete from public.questions where exam_id = p_exam_id;

    for v_q in select value from jsonb_array_elements(v_questions)
    loop
      v_position := v_position + 1;
      v_question_type := coalesce(nullif(btrim(v_q->>'question_type'),''),'mcq');
      v_prompt := btrim(coalesce(v_q->>'prompt',''));
      v_points := greatest(0.01, coalesce(nullif(v_q->>'points','')::numeric,1));

      if v_prompt = '' then
        raise exception 'Question % has no prompt.', v_position;
      end if;

      insert into public.questions(
        exam_id,
        position,
        section_title,
        prompt,
        question_type,
        choices,
        correct_answer,
        points,
        rubric_type,
        rubric_criteria,
        stimulus_type,
        stimulus_payload
      )
      values(
        p_exam_id,
        v_position,
        coalesce(nullif(btrim(v_q->>'section_title'),''),'Part 1'),
        v_prompt,
        v_question_type,
        case
          when jsonb_typeof(v_q->'choices')='array' then
            v_q->'choices'
          else null
        end,
        nullif(v_q->>'correct_answer',''),
        v_points,
        coalesce(nullif(v_q->>'rubric_type',''),'analytic'),
        case
          when jsonb_typeof(v_q->'rubric_criteria')='array' then v_q->'rubric_criteria'
          else '[]'::jsonb
        end,
        coalesce(nullif(v_q->>'stimulus_type',''),'none'),
        case
          when jsonb_typeof(v_q->'stimulus_payload')='object' then v_q->'stimulus_payload'
          else '{}'::jsonb
        end
      );
    end loop;
  end if;

  select count(*) into v_count
  from public.questions
  where exam_id = p_exam_id;

  if v_count = 0 then
    raise exception 'This examination has no questions to publish.';
  end if;

  update public.exams
  set status = 'published'
  where id = p_exam_id;

  return jsonb_build_object(
    'ok', true,
    'question_count', v_count,
    'published_at', now()
  );
end;
$$;

revoke all on function public.admin_publish_exam_from_draft(uuid) from public;
grant execute on function public.admin_publish_exam_from_draft(uuid) to authenticated;
