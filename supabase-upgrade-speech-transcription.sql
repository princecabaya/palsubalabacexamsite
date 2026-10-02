-- Exam Guard: triggered speech-audio capture + transcription
-- Run once in Supabase SQL Editor before deploying the speech Edge Functions.
-- Audio is stored in a PRIVATE bucket and ordinary clips expire after 7 days.

create table if not exists public.proctor_speech_clips (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  object_path text not null unique,
  captured_at timestamptz not null default now(),
  duration_seconds numeric(8,2),
  peak_level numeric(10,6),
  mime_type text not null default 'audio/webm',
  byte_size integer not null default 0,
  prebuffer_seconds numeric(5,2) not null default 0,
  transcript text,
  transcription_language text,
  transcription_status text not null default 'pending'
    check (transcription_status in ('pending','completed','no_speech','failed')),
  transcription_error text,
  expires_at timestamptz not null default (now() + interval '7 days'),
  evidence_saved boolean not null default false,
  evidence_saved_at timestamptz,
  evidence_saved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists proctor_speech_clips_attempt_time_idx
  on public.proctor_speech_clips(attempt_id, captured_at);

create index if not exists proctor_speech_clips_expiry_idx
  on public.proctor_speech_clips(expires_at);

create index if not exists proctor_speech_clips_evidence_idx
  on public.proctor_speech_clips(evidence_saved, captured_at);

alter table public.proctor_speech_clips enable row level security;

drop policy if exists teacher_proctor_speech_clips_select on public.proctor_speech_clips;
create policy teacher_proctor_speech_clips_select
on public.proctor_speech_clips
for select
to authenticated
using (public.exam_guard_can_access_attempt(attempt_id));

grant select on public.proctor_speech_clips to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'exam-proctor-audio',
  'exam-proctor-audio',
  false,
  4000000,
  array['audio/webm','audio/mp4','audio/ogg']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.set_proctor_speech_evidence(
  p_clip_ids uuid[],
  p_saved boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $speech_evidence$
declare
  v_count integer := 0;
begin
  if auth.uid() is null or not public.exam_guard_current_user_is_admin() then
    raise exception 'Teacher access required.';
  end if;

  update public.proctor_speech_clips c
  set evidence_saved = coalesce(p_saved, false),
      evidence_saved_at = case when coalesce(p_saved, false) then now() else null end,
      evidence_saved_by = case when coalesce(p_saved, false) then auth.uid() else null end
  where c.id = any(p_clip_ids)
    and public.exam_guard_can_access_attempt(c.attempt_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$speech_evidence$;

revoke all on function public.set_proctor_speech_evidence(uuid[],boolean) from public;
grant execute on function public.set_proctor_speech_evidence(uuid[],boolean) to authenticated;
