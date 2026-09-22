# Proctor Camera Setup

The student exam site now requests the front camera and captures a compressed still photo approximately every 60 seconds while an exam attempt is active.

Photos are stored in the private `exam-proctor-photos` Supabase Storage bucket. Unselected photos are intended to be deleted after 24 hours. Authorized teachers may preserve selected photos as examination evidence; preserved photos are excluded from automatic cleanup until released.

## 1. Database / Storage upgrade

Run the complete contents of:

`supabase-upgrade-proctor-camera.sql`

in Supabase SQL Editor.

## 2. Deploy three Edge Functions

Deploy these functions from the repository:

- `capture-proctor-photo`
- `list-proctor-photos`
- `cleanup-proctor-photos`

Recommended auth settings:

- `capture-proctor-photo`: JWT verification OFF. The function validates the active exam attempt token itself.
- `list-proctor-photos`: JWT verification ON. Only an authenticated authorized teacher is allowed to receive signed photo URLs.
- `cleanup-proctor-photos`: JWT verification OFF. Protect it with the private `PROCTOR_CLEANUP_SECRET` header described below.

Do not expose the service-role / secret key in GitHub or browser code.

## 3. Add cleanup secret

In Supabase Edge Function Secrets, add:

`PROCTOR_CLEANUP_SECRET`

with a long random secret value.

Keep this value private.

## 4. Schedule automatic cleanup

Create a Supabase Cron job that calls:

`https://edfcehmttcwhhknywflq.supabase.co/functions/v1/cleanup-proctor-photos`

once every hour.

The request must include:

- `Content-Type: application/json`
- `apikey: <your Supabase publishable key>`
- `x-cleanup-secret: <the same PROCTOR_CLEANUP_SECRET>`

An hourly schedule is:

`0 * * * *`

The cleanup function removes Storage objects older than 24 hours, including orphaned objects from attempts that were deleted before the retention period elapsed.

Supabase Cron can invoke Edge Functions from the Dashboard or with pg_cron + pg_net. Store secrets in Supabase Vault rather than hard-coding them in SQL.

## 5. Test

1. Open the student exam site on a phone.
2. Enter Exam Code and Student ID.
3. Confirm the identity popup.
4. Allow front-camera access.
5. Start the exam.
6. The exam header should show a small live front-camera preview and camera status.
7. After the first capture and then approximately every minute, the status briefly shows "Photo saved".
8. In the teacher dashboard, open that student's attempt and expand **Proctoring Photos**.
9. Verify that the image appears with capture and expiry timestamps.

## Privacy behavior

- The site visibly indicates that the front camera is active.
- The monitoring consent explicitly states the approximate one-minute photo interval and 24-hour retention.
- Photos are stored in a private bucket.
- Teacher viewing uses short-lived signed URLs.
- Teachers can select specific photos and preserve them as evidence. Preserved photos remain private and are excluded from automatic 24-hour cleanup until released.
- Main Admin may view photos while supporting another teacher; regular teachers are restricted to attempts from their own exams.
- The implementation does not record audio.
- Screen recording is not enabled.
