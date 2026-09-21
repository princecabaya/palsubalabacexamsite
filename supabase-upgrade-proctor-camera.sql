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
