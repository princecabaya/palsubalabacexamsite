# Exam Guard — GitHub Pages + Supabase

A static browser examination system that behaves like a simple Google Form while recording browser-based proctoring signals.

## What this version can monitor

It records:

- exam tab/window becoming hidden or visible;
- browser window blur/focus;
- exit/entry from fullscreen;
- copy, cut, paste, right-click, and drag attempts;
- common print, save, reload, and developer-tools keyboard shortcuts;
- `PrintScreen` key events **when the browser/operating system actually delivers that key event**;
- attempts to leave/reload the exam page;
- attempts to follow a link away from the exam page;
- exam start, submit, device screen size, and browser user-agent string.

The teacher dashboard shows a signal count per attempt and the detailed timestamped event log.

## Important browser limitations

A normal website cannot:

1. tell which desktop/mobile app the student opened after leaving the browser;
2. inspect the URLs of unrelated tabs/windows or browser history;
3. reliably prevent or detect operating-system screenshots, phone screenshots, another camera photographing the screen, or screen recording;
4. reliably prevent a student from using a second device.

Therefore, a focus/tab event is a **signal**, not proof of misconduct.

For stronger lockdown you need a managed environment such as a dedicated secure-exam browser, kiosk mode, device-management policy, or a separately installed browser extension with explicit permissions. Even then, non-browser apps require operating-system/device management rather than an ordinary web page.

## Security design

The GitHub Pages code contains only the Supabase **publishable/anon key**, which is expected to be public.

Student records are **not directly readable by anonymous visitors**. Students interact through narrowly scoped `SECURITY DEFINER` PostgreSQL functions. Teacher/admin table access is protected by Supabase Auth + Row Level Security.

Never put a Supabase `service_role` key in `config.js`, GitHub, or any browser code.

Student name + student number is convenient but is not strong authentication. For high-stakes exams, add a per-student one-time PIN/token.

## Setup

### 1. Create a Supabase project

Open the Supabase SQL Editor and run:

`supabase-schema.sql`

It creates the tables, RLS policies, RPC functions, two sample students, and a sample exam.

### 2. Create the teacher account

In Supabase:

Authentication → Users → create the teacher user.

Copy that user's UUID, then run:

```sql
update public.profiles
set is_admin = true
where user_id = 'TEACHER-AUTH-USER-UUID';
```

Only an authenticated account whose profile has `is_admin = true` can view the teacher dashboard data.

### 3. Configure the site

Copy your Supabase Project URL and **publishable/anon** key into `config.js`:

```js
window.EXAM_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR-PUBLISHABLE-OR-ANON-KEY"
};
```

### 4. Add your real students

Example:

```sql
insert into public.students(student_no, full_name)
values
  ('2026-1001','Juan Dela Cruz'),
  ('2026-1002','Maria Santos');
```

### 5. Add an exam

```sql
insert into public.exams(code,title,duration_minutes,status,start_at,end_at)
values (
  'MATH-MIDTERM',
  'Mathematics Midterm Examination',
  60,
  'published',
  '2026-10-10 08:00:00+08',
  '2026-10-10 12:00:00+08'
);
```

### 6. Add questions

```sql
insert into public.questions
(exam_id,position,prompt,question_type,choices,correct_answer,points)
select id, 1, 'What is 5 × 6?', 'mcq',
       '["25","30","35","40"]'::jsonb, '30', 1
from public.exams where code='MATH-MIDTERM';
```

The client never receives `correct_answer`.

### 7. Put it on GitHub Pages

Create a GitHub repository, add all files in this folder, and push to your default branch.

Then in GitHub:

Settings → Pages → Build and deployment → Deploy from a branch → choose the default branch and `/ (root)`.

GitHub Pages serves static HTML/JS/CSS, which is exactly what this project uses.

## Pages

- `index.html` — student examination
- `admin.html` — teacher dashboard
- `supabase-schema.sql` — database/RLS/RPC setup
- `config.js` — Supabase project URL + publishable key
- `app.js` — exam logic and proctoring signals
- `admin.js` — dashboard logic
- `style.css` — styling

## Screenshot behavior

The site blocks browser printing and common copy/paste/print shortcuts. If the browser receives a `PrintScreen` key event, it records `printscreen_key_detected`.

It **cannot guarantee screenshot prevention or detection**. Windows/macOS/Android/iOS screenshot functions operate outside normal webpage control, and some never deliver a JavaScript event to the page. The watermark showing the student's name and number is included as a deterrent and attribution aid.

## About "which website did the student open?"

A GitHub Pages website cannot read the URL of another tab because browsers isolate tabs/sites for privacy and security. The dashboard can only report that the exam became hidden or lost focus.

If exact browser-navigation monitoring is required, use a separately installed Chrome/Edge extension or managed secure browser. That should be disclosed clearly to students and deployed only on institution-managed devices or with explicit permission.
