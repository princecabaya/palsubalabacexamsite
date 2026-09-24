# Constructed Response Assessment Setup

This upgrade adds:
- Short Response
- Math Solver with the built-in web mathematics keyboard
- provisional AI scoring for Essay, Short Response, and Math Solver
- teacher review/edit/approval before the constructed-response score becomes final
- exam sections such as Part 1, Part 2, Part 3

## 1. Run the SQL upgrade

Run the full contents of:

`supabase-upgrade-constructed-responses.sql`

once in Supabase SQL Editor.

## 2. Deploy the provisional-grading Edge Function

Deploy:

`grade-constructed-responses`

The function is called by the student site immediately after a submitted exam.

Recommended setting:
- JWT verification OFF

The attempt token is validated by the function before grading. The Supabase admin/service key remains server-side only.

## 3. Required secrets

The function reuses the same Gemini configuration as the existing feedback function:

- `GEMINI_API_KEY`
- optional `GEMINI_MODEL`

No new AI key is required if the existing Gemini feedback feature is already working.

## 4. Teacher review workflow

For a submitted exam containing Essay, Short Response, or Math Solver items:

1. The objective MCQ/Binary score is recorded immediately.
2. `grade-constructed-responses` generates provisional scores for constructed responses.
3. The attempt is marked as awaiting teacher review.
4. In Manage Exams -> exam results, click **Review Scores**.
5. Review each student response, provisional AI score, and explanation.
6. Edit any score that is not appropriate.
7. Click **Approve Final Scores**.
8. Only then is the complete score treated as final and included in ranking.

Proctors do not receive approval permission; only the exam owner or Main Admin can approve final constructed-response scores.

## 5. Short Response behavior

The reference answer is used as the grading reference. Exact normalized matches receive immediate full provisional credit. Other answers are evaluated semantically by AI, allowing harmless variations such as punctuation, capitalization, minor spelling variation, or reordered personal names when they clearly identify the same answer.

Example:
Reference: `Jose P. Rizal`
Student: `Rizal, Jose P.`

The AI can provisionally recognize these as equivalent, but the teacher still makes the final decision.

## 6. Math Solver behavior

Students cannot type directly into the Math Solver board with the ordinary keyboard. They use the built-in web mathematics keyboard with numeric, algebraic-letter, Greek, and function tabs. The solution board expands as content is entered.

The AI-generated math score is provisional only and should be reviewed by the teacher.

## 7. Exam sections

Use **Add Section / Part** near the bottom of Create Exam.

After adding a new section:
- manually added questions continue under that section;
- an Excel or LaTeX import will append to the newest section instead of replacing the earlier parts.

The default first section is `Part 1`.


## OpenAI fallback

The constructed-response grading function now uses this provider order:

1. Gemini
2. OpenAI
3. Teacher manual scoring

To enable the OpenAI fallback, add these Supabase Edge Function secrets:

- `OPENAI_API_KEY`
- optional `OPENAI_MODEL`

The default OpenAI fallback model in the function is `gpt-5.4-mini`.

If Gemini fails or is unavailable, the function tries OpenAI automatically. If both AI providers fail, no constructed-response item is automatically forced to zero. The teacher review screen remains available for manual scoring and final approval.
