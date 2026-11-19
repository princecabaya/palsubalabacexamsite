-- Exam Guard: preserve legacy recovery answers for result-report evidence
create table if not exists private.attempt_legacy_recovery_evidence (
  attempt_id uuid primary key references public.attempts(id) on delete cascade,
  answers jsonb not null,
  answered_count integer not null,
  recovery_created_at timestamptz,
  recovery_expires_at timestamptz,
  preserved_at timestamptz not null default now()
);

revoke all on table private.attempt_legacy_recovery_evidence from public, anon, authenticated;

insert into private.attempt_legacy_recovery_evidence(
  attempt_id,answers,answered_count,recovery_created_at,recovery_expires_at,preserved_at
)
select distinct on (ars.attempt_id)
  ars.attempt_id,ars.answers,ars.answered_count,ars.created_at,ars.expires_at,now()
from public.attempt_recovery_snapshots ars
join public.attempts a on a.id=ars.attempt_id
where a.status='submitted'
  and coalesce(ars.answered_count,0)>0
  and not exists (select 1 from public.responses r where r.attempt_id=ars.attempt_id)
  and not exists (select 1 from public.attempt_question_snapshots s where s.attempt_id=ars.attempt_id)
order by ars.attempt_id,ars.created_at desc
on conflict(attempt_id) do update
set answers=excluded.answers,
    answered_count=excluded.answered_count,
    recovery_created_at=excluded.recovery_created_at,
    recovery_expires_at=excluded.recovery_expires_at,
    preserved_at=now();

-- private.exam_guard_attach_recovery_evidence(p_attempt_id uuid, p_report jsonb)
CREATE OR REPLACE FUNCTION private.exam_guard_attach_recovery_evidence(p_attempt_id uuid, p_report jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_answers jsonb;
  v_count integer;
  v_created timestamptz;
  v_preserved timestamptz;
  v_entries jsonb;
begin
  if p_report is null then
    return null;
  end if;

  -- Only attach raw legacy evidence when no item-level historical snapshot exists
  -- and no permanent response rows survived.
  if exists (
    select 1 from public.attempt_question_snapshots s
    where s.attempt_id=p_attempt_id
  ) or exists (
    select 1 from public.responses r
    where r.attempt_id=p_attempt_id
  ) then
    return p_report;
  end if;

  select e.answers,e.answered_count,e.recovery_created_at,e.preserved_at
  into v_answers,v_count,v_created,v_preserved
  from private.attempt_legacy_recovery_evidence e
  where e.attempt_id=p_attempt_id;

  if v_answers is null then
    return p_report;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'recovery_key',x.key,
        'answer',x.value
      )
      order by x.key
    ),
    '[]'::jsonb
  )
  into v_entries
  from jsonb_each_text(v_answers) x
  where btrim(coalesce(x.value,''))<>'';

  return p_report || jsonb_build_object(
    'legacy_recovery_evidence',true,
    'recovery_mapping_status','unmapped_legacy',
    'recovery_answer_count',coalesce(v_count,jsonb_array_length(v_entries)),
    'recovery_captured_at',v_created,
    'recovery_preserved_at',v_preserved,
    'recovery_answers',v_entries
  );
end;
$function$;

-- public.admin_get_attempt_report(p_attempt_id uuid)
CREATE OR REPLACE FUNCTION public.admin_get_attempt_report(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_report jsonb;
begin
  if auth.uid() is null or not public.exam_guard_can_view_attempt(p_attempt_id) then
    raise exception 'You do not have access to this exam attempt.';
  end if;

  v_report := public.exam_guard_build_attempt_report(p_attempt_id);

  if v_report is null then
    raise exception 'Only submitted attempts have result reports.';
  end if;

  return private.exam_guard_attach_recovery_evidence(p_attempt_id,v_report);
end;
$function$;

-- public.get_submitted_exam_report(p_attempt_token uuid)
CREATE OR REPLACE FUNCTION public.get_submitted_exam_report(p_attempt_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.attempts%rowtype;
  v_results_released boolean:=false;
  v_report jsonb;
begin
  select a.* into v_attempt
  from public.attempts a
  where a.attempt_token=p_attempt_token
    and a.status='submitted';

  if v_attempt.id is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  select coalesce(e.results_released,false)
  into v_results_released
  from public.exams e
  where e.id=v_attempt.exam_id;

  if not v_results_released then
    raise exception 'The full item-by-item result is not yet released by your teacher.';
  end if;

  v_report := public.exam_guard_build_attempt_report(v_attempt.id);

  if v_report is null then
    raise exception 'Submitted exam report is not available.';
  end if;

  return private.exam_guard_attach_recovery_evidence(v_attempt.id,v_report)
         || jsonb_build_object('results_released',true);
end;
$function$;

revoke all on function private.exam_guard_attach_recovery_evidence(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.admin_get_attempt_report(uuid) from public, anon;
grant execute on function public.admin_get_attempt_report(uuid) to authenticated;
