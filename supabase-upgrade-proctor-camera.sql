-- Front-camera proctoring photos with 24-hour retention.
-- Run once in Supabase SQL Editor.
-- Photos are stored in a PRIVATE Storage bucket.

create table if not exists public.proctor_photos (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  object_path text not null unique,
  captured_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);

create index if not exists proctor_photos_attempt_time_idx
  on public.proctor_photos(attempt_id, captured_at);

create index if not exists proctor_photos_expiry_idx
  on public.proctor_photos(expires_at);

alter table public.proctor_photos enable row level security;

drop policy if exists teacher_proctor_photos_select on public.proctor_photos;
create policy teacher_proctor_photos_select
on public.proctor_photos
for select
to authenticated
using (public.exam_guard_can_access_attempt(attempt_id));

-- Browser clients do not directly insert/delete photos.
-- Uploads and cleanup are performed by Edge Functions using a server-side admin key.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'exam-proctor-photos',
  'exam-proctor-photos',
  false,
  600000,
  array['image/jpeg']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

grant select on public.proctor_photos to authenticated;


-- ---------- Preserved proctor-photo evidence ----------
alter table public.proctor_photos
  add column if not exists evidence_saved boolean not null default false,
  add column if not exists evidence_saved_at timestamptz,
  add column if not exists evidence_saved_by uuid references auth.users(id) on delete set null;

create index if not exists proctor_photos_evidence_idx
  on public.proctor_photos(evidence_saved, captured_at);

create or replace function public.set_proctor_photo_evidence(
  p_photo_ids uuid[],
  p_saved boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $evidence$
declare
  v_count integer := 0;
begin
  if auth.uid() is null or not public.exam_guard_current_user_is_admin() then
    raise exception 'Teacher access required.';
  end if;

  update public.proctor_photos p
  set evidence_saved = coalesce(p_saved, false),
      evidence_saved_at = case when coalesce(p_saved, false) then now() else null end,
      evidence_saved_by = case when coalesce(p_saved, false) then auth.uid() else null end
  where p.id = any(p_photo_ids)
    and public.exam_guard_can_access_attempt(p.attempt_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$evidence$;

revoke all on function public.set_proctor_photo_evidence(uuid[],boolean) from public;
grant execute on function public.set_proctor_photo_evidence(uuid[],boolean) to authenticated;

