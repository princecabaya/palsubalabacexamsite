-- Exam Guard: immutable per-attempt question snapshots
-- Purpose:
-- 1) Preserve the exact exam version each student actually received.
-- 2) Preserve student answers even if live questions are later replaced.
-- 3) Generate result reports from the historical attempt snapshot.
-- 4) Keep direct snapshot-table access blocked; expose data only through RPCs.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.attempt_question_snapshots (
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  original_question_id uuid not null,
  exam_id uuid not null,
  position integer not null,
  section_title text,
  prompt text not null,
  question_type text not null,
  choices jsonb,
  correct_answer text,
  points numeric not null,
  rubric_type text,
  rubric_criteria jsonb,
  stimulus_type text,
  stimulus_payload jsonb,
  student_answer text,
  answer_saved_at timestamptz,
  essay_submitted_at timestamptz,
  provisional_score numeric,
  provisional_reason text,
  teacher_score numeric,
  teacher_comment text,
  teacher_rubric_scores jsonb,
  review_status text,
  reviewed_at timestamptz,
  reviewed_by uuid,
  captured_at timestamptz not null default now(),
  primary key (attempt_id, original_question_id),
  unique (attempt_id, position)
);

alter table public.attempt_question_snapshots enable row level security;
revoke all on table public.attempt_question_snapshots from public, anon, authenticated;

create index if not exists attempt_question_snapshots_exam_idx
  on public.attempt_question_snapshots(exam_id);
create index if not exists attempt_question_snapshots_attempt_position_idx
  on public.attempt_question_snapshots(attempt_id, position);

create or replace function private.capture_attempt_question_snapshot(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam_id uuid;
begin
  select a.exam_id into v_exam_id
  from public.attempts a
  where a.id=p_attempt_id;

  if v_exam_id is null then return; end if;

  if exists (
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=p_attempt_id
  ) then
    return;
  end if;

  insert into public.attempt_question_snapshots(
    attempt_id,original_question_id,exam_id,position,section_title,
    prompt,question_type,choices,correct_answer,points,
    rubric_type,rubric_criteria,stimulus_type,stimulus_payload
  )
  select
    p_attempt_id,q.id,q.exam_id,q.position,q.section_title,
    q.prompt,q.question_type,q.choices,q.correct_answer,q.points,
    q.rubric_type,q.rubric_criteria,q.stimulus_type,q.stimulus_payload
  from public.questions q
  where q.exam_id=v_exam_id
  order by q.position;
end;
$$;

revoke all on function private.capture_attempt_question_snapshot(uuid)
from public, anon, authenticated;

create or replace function private.capture_attempt_questions_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.capture_attempt_question_snapshot(new.id);
  return new;
end;
$$;

drop trigger if exists capture_attempt_questions_after_insert on public.attempts;
create trigger capture_attempt_questions_after_insert
after insert on public.attempts
for each row execute function private.capture_attempt_questions_after_insert();

create or replace function private.sync_response_to_attempt_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.attempt_question_snapshots s
  set student_answer=new.answer,
      answer_saved_at=new.saved_at,
      essay_submitted_at=new.essay_submitted_at,
      provisional_score=new.provisional_score,
      provisional_reason=new.provisional_reason,
      teacher_score=new.teacher_score,
      teacher_comment=new.teacher_comment,
      teacher_rubric_scores=new.teacher_rubric_scores,
      review_status=new.review_status,
      reviewed_at=new.reviewed_at,
      reviewed_by=new.reviewed_by
  where s.attempt_id=new.attempt_id
    and s.original_question_id=new.question_id;
  return new;
end;
$$;

drop trigger if exists sync_response_to_attempt_snapshot on public.responses;
create trigger sync_response_to_attempt_snapshot
after insert or update on public.responses
for each row execute function private.sync_response_to_attempt_snapshot();

-- Active attempts are safe to backfill because Exam Guard blocks question edits
-- while an active student attempt exists.
do $$
declare r record;
begin
  for r in
    select a.id
    from public.attempts a
    where a.status='active'
      and not exists(
        select 1 from public.attempt_question_snapshots s
        where s.attempt_id=a.id
      )
  loop
    perform private.capture_attempt_question_snapshot(r.id);
  end loop;
end;
$$;

update public.attempt_question_snapshots s
set student_answer=r.answer,
    answer_saved_at=r.saved_at,
    essay_submitted_at=r.essay_submitted_at,
    provisional_score=r.provisional_score,
    provisional_reason=r.provisional_reason,
    teacher_score=r.teacher_score,
    teacher_comment=r.teacher_comment,
    teacher_rubric_scores=r.teacher_rubric_scores,
    review_status=r.review_status,
    reviewed_at=r.reviewed_at,
    reviewed_by=r.reviewed_by
from public.responses r
where r.attempt_id=s.attempt_id
  and r.question_id=s.original_question_id;

create or replace function public.get_exam_questions(p_attempt_token uuid)
returns table(
  question_id uuid,
  "position" integer,
  section_title text,
  prompt text,
  question_type text,
  choices jsonb,
  points numeric,
  rubric_type text,
  rubric_criteria jsonb,
  stimulus_type text,
  stimulus_payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found or v_attempt.status<>'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now()>public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts set status='expired' where id=v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  if not exists(
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=v_attempt.id
  ) then
    perform private.capture_attempt_question_snapshot(v_attempt.id);
  end if;

  return query
  select
    s.original_question_id,s.position,s.section_title,s.prompt,
    s.question_type,s.choices,s.points,s.rubric_type,s.rubric_criteria,
    s.stimulus_type,s.stimulus_payload
  from public.attempt_question_snapshots s
  where s.attempt_id=v_attempt.id
  order by s.position;
end;
$$;

create or replace function public.save_exam_response(
  p_attempt_token uuid,
  p_question_id uuid,
  p_answer text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
  v_existing public.responses%rowtype;
  v_incoming text:=left(coalesce(p_answer,''),20000);
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found or v_attempt.status<>'active' then
    raise exception 'Invalid or inactive exam attempt.';
  end if;

  if now()>public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts set status='expired' where id=v_attempt.id;
    raise exception 'Exam time has expired.';
  end if;

  if not exists(
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=v_attempt.id
      and s.original_question_id=p_question_id
  ) then
    raise exception 'Question does not belong to this attempt.';
  end if;

  select * into v_existing
  from public.responses
  where attempt_id=v_attempt.id and question_id=p_question_id
  for update;

  if found and v_existing.essay_submitted_at is not null then return; end if;

  if found
     and coalesce(v_existing.teacher_recovered,false)=true
     and btrim(coalesce(v_existing.answer,''))<>''
     and btrim(v_incoming)='' then
    return;
  end if;

  update public.attempt_question_snapshots
  set student_answer=v_incoming,
      answer_saved_at=now()
  where attempt_id=v_attempt.id
    and original_question_id=p_question_id;

  if exists(
    select 1 from public.questions q
    where q.id=p_question_id and q.exam_id=v_attempt.exam_id
  ) then
    insert into public.responses(
      attempt_id,question_id,answer,saved_at,
      teacher_recovered,teacher_recovered_by,teacher_recovered_at
    )
    values(
      v_attempt.id,p_question_id,v_incoming,now(),
      false,null,null
    )
    on conflict(attempt_id,question_id)
    do update set
      answer=excluded.answer,
      saved_at=now(),
      teacher_recovered=false,
      teacher_recovered_by=null,
      teacher_recovered_at=null;
  end if;
end;
$$;

create or replace function public.get_saved_exam_responses(p_attempt_token uuid)
returns table(
  question_id uuid,
  answer text,
  saved_at timestamptz,
  essay_submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found or v_attempt.status<>'active' then
    raise exception 'No active exam session was found.';
  end if;

  if now()>public.exam_guard_attempt_ends_at(v_attempt.id) then
    update public.attempts set status='expired' where id=v_attempt.id;
    raise exception 'The saved exam session has expired.';
  end if;

  return query
  select s.original_question_id,coalesce(s.student_answer,''),
         s.answer_saved_at,s.essay_submitted_at
  from public.attempt_question_snapshots s
  where s.attempt_id=v_attempt.id
    and s.answer_saved_at is not null
  order by s.answer_saved_at;
end;
$$;

create or replace function public.get_attempt_saved_response_state(p_attempt_token uuid)
returns table(question_id uuid, answer text, saved_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found then raise exception 'Invalid exam attempt.'; end if;
  if v_attempt.status<>'active' then raise exception 'Exam attempt is not active.'; end if;

  return query
  select s.original_question_id,coalesce(s.student_answer,''),s.answer_saved_at
  from public.attempt_question_snapshots s
  where s.attempt_id=v_attempt.id
    and s.answer_saved_at is not null
  order by s.answer_saved_at;
end;
$$;

create or replace function public.submit_exam_verified(
  p_attempt_token uuid,
  p_expected_nonblank integer
)
returns table(score numeric,max_score numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
  v_saved_nonblank integer:=0;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found then raise exception 'Invalid exam attempt.'; end if;

  if v_attempt.status='submitted' then
    return query select v_attempt.score,v_attempt.max_score;
    return;
  end if;

  if v_attempt.status<>'active' then raise exception 'Exam attempt is not active.'; end if;

  select count(*) into v_saved_nonblank
  from public.attempt_question_snapshots s
  where s.attempt_id=v_attempt.id
    and btrim(coalesce(s.student_answer,''))<>'';

  if v_saved_nonblank<greatest(coalesce(p_expected_nonblank,0),0) then
    raise exception
      'Submission verification failed: the server has % nonblank saved response(s), but the browser reports % answered item(s). Please retry saving before submission.',
      v_saved_nonblank,greatest(coalesce(p_expected_nonblank,0),0);
  end if;

  return query select * from public.submit_exam(p_attempt_token);
end;
$$;

create or replace function public.submit_exam(p_attempt_token uuid)
returns table(score numeric,max_score numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.attempts%rowtype;
  v_score numeric;
  v_auto_max numeric;
  v_has_constructed boolean;
begin
  select * into v_attempt
  from public.attempts
  where attempt_token=p_attempt_token;

  if not found then raise exception 'Invalid exam attempt.'; end if;

  if v_attempt.status='submitted' then
    return query select v_attempt.score,v_attempt.max_score;
    return;
  end if;

  if not exists(
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=v_attempt.id
  ) then
    perform private.capture_attempt_question_snapshot(v_attempt.id);
  end if;

  select
    coalesce(sum(case
      when s.question_type in ('mcq','binary','short_response')
       and s.correct_answer is not null
       and regexp_replace(lower(btrim(coalesce(s.student_answer,''))),'\s+',' ','g')
           =regexp_replace(lower(btrim(s.correct_answer)),'\s+',' ','g')
      then s.points else 0 end),0),
    coalesce(sum(case
      when s.question_type in ('mcq','binary','short_response')
      then s.points else 0 end),0),
    bool_or(s.question_type in ('essay','text','math_solver'))
  into v_score,v_auto_max,v_has_constructed
  from public.attempt_question_snapshots s
  where s.attempt_id=v_attempt.id;

  update public.responses r
  set review_status='pending'
  from public.attempt_question_snapshots s
  where r.attempt_id=v_attempt.id
    and r.question_id=s.original_question_id
    and s.attempt_id=v_attempt.id
    and s.question_type in ('essay','text','math_solver');

  update public.attempt_question_snapshots
  set review_status=case
    when question_type in ('essay','text','math_solver') then 'pending'
    else review_status
  end
  where attempt_id=v_attempt.id;

  update public.attempts
  set status='submitted',
      submitted_at=now(),
      score=v_score,
      max_score=v_auto_max,
      grading_status=case
        when coalesce(v_has_constructed,false) then 'pending_ai'
        else 'approved'
      end,
      provisional_score=null,
      provisional_max_score=null
  where id=v_attempt.id;

  insert into public.proctor_events(attempt_id,event_type,details)
  values(
    v_attempt.id,'exam_submitted',
    jsonb_build_object(
      'auto_score',v_score,
      'auto_max_score',v_auto_max,
      'constructed_review_required',coalesce(v_has_constructed,false),
      'question_snapshot_preserved',true
    )
  );

  return query select v_score,v_auto_max;
end;
$$;

-- The report builder now prefers the immutable attempt snapshot.
create or replace function public.exam_guard_build_attempt_report(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_report jsonb;
begin
  if exists(
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=p_attempt_id
  ) then
    select jsonb_build_object(
      'attempt_id',a.id,
      'student_name',st.full_name,
      'student_no',st.student_no,
      'exam_title',e.title,
      'exam_code',e.code,
      'teacher_name',coalesce(nullif(ea.display_name,''),nullif(ea.email,''),'Teacher'),
      'grading_status',a.grading_status,
      'started_at',a.started_at,
      'submitted_at',a.submitted_at,
      'score',case
        when a.grading_status in ('pending_ai','pending_review')
         and a.provisional_score is not null then a.provisional_score
        else a.score end,
      'max_score',case
        when a.grading_status in ('pending_ai','pending_review')
         and a.provisional_max_score is not null then a.provisional_max_score
        else a.max_score end,
      'percentage',case
        when a.grading_status in ('pending_ai','pending_review')
         and coalesce(a.provisional_max_score,0)>0
          then round((a.provisional_score/a.provisional_max_score)*100,2)
        when coalesce(a.max_score,0)>0
          then round((a.score/a.max_score)*100,2)
        else null end,
      'items',coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'position',s.position,
            'section_title',s.section_title,
            'prompt',s.prompt,
            'question_type',s.question_type,
            'student_answer',coalesce(s.student_answer,''),
            'correct_answer',s.correct_answer,
            'points',s.points,
            'provisional_reason',s.provisional_reason,
            'points_awarded',case
              when s.question_type in ('mcq','binary','short_response') then
                case
                  when s.correct_answer is not null
                   and regexp_replace(lower(btrim(coalesce(s.student_answer,''))),'\s+',' ','g')
                       =regexp_replace(lower(btrim(s.correct_answer)),'\s+',' ','g')
                  then s.points else 0 end
              when a.grading_status='approved' then s.teacher_score
              else s.provisional_score end,
            'result',case
              when s.question_type in ('mcq','binary','short_response') then
                case
                  when s.correct_answer is not null
                   and regexp_replace(lower(btrim(coalesce(s.student_answer,''))),'\s+',' ','g')
                       =regexp_replace(lower(btrim(s.correct_answer)),'\s+',' ','g')
                  then 'correct' else 'wrong' end
              when a.grading_status='approved' then 'approved'
              else 'pending_review' end
          )
          order by s.position
        )
        from public.attempt_question_snapshots s
        where s.attempt_id=a.id
      ),'[]'::jsonb)
    )
    into v_report
    from public.attempts a
    join public.students st on st.id=a.student_id
    join public.exams e on e.id=a.exam_id
    left join public.exam_admins ea on ea.user_id=e.owner_id
    where a.id=p_attempt_id and a.status='submitted';

    return v_report;
  end if;

  -- Legacy attempts created before snapshots continue to use the old live-table path.
  select jsonb_build_object(
    'attempt_id',a.id,
    'student_name',st.full_name,
    'student_no',st.student_no,
    'exam_title',e.title,
    'exam_code',e.code,
    'teacher_name',coalesce(nullif(ea.display_name,''),nullif(ea.email,''),'Teacher'),
    'grading_status',a.grading_status,
    'started_at',a.started_at,
    'submitted_at',a.submitted_at,
    'score',a.score,
    'max_score',a.max_score,
    'percentage',case when coalesce(a.max_score,0)>0
      then round((a.score/a.max_score)*100,2) else null end,
    'items',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'position',q.position,
          'section_title',q.section_title,
          'prompt',q.prompt,
          'question_type',q.question_type,
          'student_answer',coalesce(r.answer,''),
          'correct_answer',q.correct_answer,
          'points',q.points,
          'provisional_reason',r.provisional_reason,
          'points_awarded',case
            when q.question_type in ('mcq','binary','short_response') then
              case
                when q.correct_answer is not null
                 and regexp_replace(lower(btrim(coalesce(r.answer,''))),'\s+',' ','g')
                     =regexp_replace(lower(btrim(q.correct_answer)),'\s+',' ','g')
                then q.points else 0 end
            when a.grading_status='approved' then r.teacher_score
            else r.provisional_score end,
          'result',case
            when q.question_type in ('mcq','binary','short_response') then
              case
                when q.correct_answer is not null
                 and regexp_replace(lower(btrim(coalesce(r.answer,''))),'\s+',' ','g')
                     =regexp_replace(lower(btrim(q.correct_answer)),'\s+',' ','g')
                then 'correct' else 'wrong' end
            when a.grading_status='approved' then 'approved'
            else 'pending_review' end
        )
        order by q.position
      )
      from public.questions q
      left join public.responses r
        on r.question_id=q.id and r.attempt_id=a.id
      where q.exam_id=a.exam_id
    ),'[]'::jsonb)
  )
  into v_report
  from public.attempts a
  join public.students st on st.id=a.student_id
  join public.exams e on e.id=a.exam_id
  left join public.exam_admins ea on ea.user_id=e.owner_id
  where a.id=p_attempt_id and a.status='submitted';

  return v_report;
end;
$$;

-- Low-level report builder is internal only.
revoke all on function public.exam_guard_build_attempt_report(uuid)
from public, anon, authenticated;

-- Admin functions touched by this upgrade should not be anonymously callable.
revoke all on function public.admin_save_recovered_response(uuid,uuid,text) from public, anon;
grant execute on function public.admin_save_recovered_response(uuid,uuid,text) to authenticated;
revoke all on function public.admin_approve_constructed_scores(uuid,jsonb) from public, anon;
grant execute on function public.admin_approve_constructed_scores(uuid,jsonb) to authenticated;
revoke all on function public.admin_permit_submitted_attempt_edit(uuid,integer) from public, anon;
grant execute on function public.admin_permit_submitted_attempt_edit(uuid,integer) to authenticated;
revoke all on function public.admin_reopen_attempt(uuid) from public, anon;
grant execute on function public.admin_reopen_attempt(uuid) to authenticated;

-- NOTE: the production upgrade also updates submit_essay_response,
-- admin_save_recovered_response, admin_approve_constructed_scores,
-- admin_permit_submitted_attempt_edit, and admin_reopen_attempt to keep
-- historical snapshot answer/grading fields synchronized during revisions.
