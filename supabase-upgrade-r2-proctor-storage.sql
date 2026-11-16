-- Exam Guard: Cloudflare R2 hybrid proctoring storage.
-- Existing media stays in Supabase Storage; new media may use R2.
-- Safe to run more than once.

alter table public.proctor_photos
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists byte_size bigint;

alter table public.proctor_speech_clips
  add column if not exists storage_provider text not null default 'supabase';

update public.proctor_photos
set storage_provider='supabase'
where storage_provider is null or btrim(storage_provider)='';

update public.proctor_speech_clips
set storage_provider='supabase'
where storage_provider is null or btrim(storage_provider)='';

alter table public.proctor_photos
  drop constraint if exists proctor_photos_storage_provider_check;
alter table public.proctor_photos
  add constraint proctor_photos_storage_provider_check
  check (storage_provider in ('supabase','r2'));

alter table public.proctor_speech_clips
  drop constraint if exists proctor_speech_clips_storage_provider_check;
alter table public.proctor_speech_clips
  add constraint proctor_speech_clips_storage_provider_check
  check (storage_provider in ('supabase','r2'));
