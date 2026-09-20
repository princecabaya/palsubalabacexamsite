# PalSU Balabac Exam Site — Finish Setup

Your website files are already in this repository. You do **not** need to upload the ZIP again.

## 1. Supabase database setup

Your Supabase project ID is:

`edfcehmttcwhhknywflq`

Open the project in Supabase, then go to:

**SQL Editor → New query**

Open the file `supabase-schema.sql` from this GitHub repository, copy the entire SQL file, paste it into Supabase SQL Editor, and click **Run**.

> Do not paste `supabase-schema.sql` into Edge Functions. The current site does not require a Supabase Edge Function.

The SQL creates these tables:

- `students`
- `exams`
- `questions`
- `attempts`
- `responses`
- `proctor_events`
- `profiles`

It also creates the RPC functions used by the student website.

## 2. Add the Supabase publishable key

In Supabase open:

**Project Settings → API Keys**

Copy the **Publishable key**. If your project still shows legacy keys, use the **anon/public** key.

Then open `config.js` in this GitHub repository and replace:

```text
PASTE-YOUR-SUPABASE-PUBLISHABLE-OR-ANON-KEY-HERE
```

with that publishable/anon key.

The project URL is already configured as:

```text
https://edfcehmttcwhhknywflq.supabase.co
```

**Never put the service_role key or a secret key in GitHub.**

## 3. Create your teacher login

In Supabase open:

**Authentication → Users → Add user**

Create your teacher email/password account.

Copy the teacher user's UUID.

Then return to **SQL Editor** and run:

```sql
update public.profiles
set is_admin = true
where user_id = 'PASTE-TEACHER-AUTH-USER-UUID-HERE';
```

## 4. Add students

Use Supabase **SQL Editor**. Example:

```sql
insert into public.students(student_no, full_name)
values
  ('2026-0001', 'Sample Student One'),
  ('2026-0002', 'Sample Student Two');
```

You can later replace these with your real PSU Balabac student names and numbers.

## 5. Add exams/questions

The file `supabase-schema.sql` already creates a demo examination called:

```text
DEMO-EXAM
```

Use that first to test the site.

After the system works, add your actual examinations and questions through SQL. A teacher exam-builder interface can be added later so you will not need to type SQL manually.

## 6. Turn on GitHub Pages

In this repository open:

**Settings → Pages**

Under **Build and deployment** choose:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

Save.

Your student site should then be available at:

```text
https://princecabaya.github.io/palsubalabacexamsite/
```

Teacher dashboard:

```text
https://princecabaya.github.io/palsubalabacexamsite/admin.html
```

## File map

| File | Purpose |
|---|---|
| `index.html` | Student exam page |
| `admin.html` | Teacher dashboard |
| `config.js` | Supabase URL + publishable/anon key |
| `app.js` | Student exam + monitoring logic |
| `admin.js` | Teacher dashboard logic |
| `style.css` | Site appearance |
| `supabase-schema.sql` | Paste/run in Supabase SQL Editor |
| `README.md` | Full project documentation |

## What you do NOT need to upload to Supabase

Do not upload `index.html`, `admin.html`, `app.js`, `admin.js`, or `style.css` to Supabase.

Those files stay in GitHub.

Supabase is only being used for the database, authentication, and RPC functions in the current version.
