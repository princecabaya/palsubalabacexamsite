# AI Feedback Setup (Gemini + Supabase Edge Function)

The GitHub Pages site is already wired to call a Supabase Edge Function named:

`generate-feedback`

The AI API key must stay in Supabase. Do **not** put it in `config.js`, GitHub, or browser JavaScript.

## Step 1 — Run the database upgrade

In Supabase:

**SQL Editor → New query**

Copy and run the contents of:

`supabase-upgrade-results-ai.sql`

This adds storage for AI feedback to the `responses` table.

## Step 2 — Create a Gemini API key

Create a Gemini API key in Google AI Studio.

Do not paste the key into GitHub.

## Step 3 — Save the Gemini key as a Supabase secret

In Supabase, open **Edge Function Secrets**.

Add:

```
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

Optional:

```
GEMINI_MODEL=gemini-flash-latest
```

If `GEMINI_MODEL` is omitted, the function already defaults to `gemini-flash-latest`.

## Step 4 — Deploy the Edge Function

Create/deploy a Supabase Edge Function named:

`generate-feedback`

Use the code in:

`supabase/functions/generate-feedback/index.ts`

You can deploy through your Supabase Edge Function workflow or the Supabase CLI.

CLI example:

```bash
supabase functions deploy generate-feedback
```

## What is sent to Gemini

For incorrect auto-scored questions only:

- question text
- student's answer
- correct answer (server-side context for producing accurate feedback)

The code does **not** send the student's name, student number, email address, rank, or proctoring events to Gemini.

## What students see

After submitting, the result page requests AI feedback for incorrect auto-scored answers.

The prompt asks Gemini to:

- explain the misconception;
- suggest the concept/reasoning to review;
- avoid simply revealing the answer verbatim;
- avoid discussing grades, rank, or monitoring.

If the Edge Function or Gemini is unavailable, the exam remains submitted normally and the student simply sees that AI feedback is unavailable.
