# Triggered Speech Recording & Transcription Setup

This upgrade keeps the existing local microphone speech detector, but adds short audio capture only after sustained speech reaches the detector's activation threshold.

## Behavior

- The microphone level is still analyzed locally.
- A speech event must remain above the existing threshold long enough to activate.
- When activated, the browser keeps the rolling pre-trigger audio and records a short clip.
- Clips are capped at about 12 seconds.
- A 10-second cooldown limits repeated uploads.
- The clip is stored in the private `exam-proctor-audio` bucket.
- The Edge Function sends the audio to Gemini for transcription.
- Teachers can listen to the original clip and review the machine transcript in the attempt drawer.
- Ordinary clips expire after 7 days. Selected clips can be preserved as evidence.

## 1. Run the database upgrade

Run:

`supabase-upgrade-speech-transcription.sql`

in the Supabase SQL Editor.

This creates:

- `proctor_speech_clips`
- private Storage bucket `exam-proctor-audio`
- teacher read policy
- `set_proctor_speech_evidence(...)`

## 2. Deploy the Edge Functions

Deploy:

- `capture-speech-clip`
- `list-speech-clips`
- `cleanup-proctor-audio`

Example with the Supabase CLI:

```bash
supabase functions deploy capture-speech-clip
supabase functions deploy list-speech-clips
supabase functions deploy cleanup-proctor-audio
```

## 3. Gemini secret

The transcription function reuses `GEMINI_API_KEY`.

Optional:

```bash
supabase secrets set GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash
```

If `GEMINI_TRANSCRIBE_MODEL` is not set, the function uses `GEMINI_MODEL`, then falls back to `gemini-2.5-flash`.

## 4. Cleanup

The cleanup function requires `PROCTOR_CLEANUP_KEY`. Configure it as a Supabase secret and call `cleanup-proctor-audio` from a scheduled job with the same value in the `x-cleanup-key` header.

Preserved evidence is not deleted by normal cleanup.

## Important review rule

The transcript is a machine-generated review aid, not proof of who spoke or of misconduct. Teachers should listen to the original clip and consider nearby voices, room noise, code-switching, and transcription errors before making a decision.
