import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "exam-proctor-audio";
const MAX_BYTES = 4_000_000;
const ALLOWED_MIME = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const attemptToken = String(body?.attempt_token || "").trim();
    const audioBase64 = String(body?.audio_base64 || "").trim();
    const rawMime = String(body?.mime_type || "audio/webm").split(";")[0].trim().toLowerCase();
    const durationSeconds = Math.max(0, Math.min(20, Number(body?.duration_seconds || 0)));
    const peakLevel = Math.max(0, Number(body?.peak_level || 0));
    const prebufferSeconds = Math.max(0, Math.min(3, Number(body?.prebuffer_seconds || 0)));

    if (!/^[0-9a-f-]{36}$/i.test(attemptToken)) return json({ error: "Invalid attempt token." }, 400);
    if (!audioBase64) return json({ error: "Audio data is required." }, 400);
    if (!ALLOWED_MIME.has(rawMime)) return json({ error: "Unsupported audio format." }, 415);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getSupabaseAdminKey();
    const geminiKey = String(Deno.env.get("GEMINI_API_KEY") || "").trim();
    const geminiModel = String(
      Deno.env.get("GEMINI_TRANSCRIBE_MODEL") ||
      Deno.env.get("GEMINI_MODEL") ||
      "gemini-2.5-flash"
    ).trim();

    if (!supabaseUrl || !serviceKey) return json({ error: "Supabase server configuration is incomplete." }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: attempt, error: attemptError } = await admin
      .from("attempts")
      .select("id,status,started_at,extended_until,exam_id,exams(duration_minutes,end_at)")
      .eq("attempt_token", attemptToken)
      .maybeSingle();

    if (attemptError) throw attemptError;
    if (!attempt) return json({ error: "Exam attempt not found." }, 404);
    if (attempt.status !== "active") return json({ error: "Exam attempt is not active." }, 409);

    const exam = Array.isArray(attempt.exams) ? attempt.exams[0] : attempt.exams;
    const durationMs = Number(exam?.duration_minutes || 0) * 60_000;
    const attemptEnd = new Date(attempt.started_at).getTime() + durationMs;
    const scheduledEnd = exam?.end_at ? new Date(exam.end_at).getTime() : Number.POSITIVE_INFINITY;
    const baseEnd = Math.min(attemptEnd, scheduledEnd);
    const extendedEnd = attempt.extended_until ? new Date(attempt.extended_until).getTime() : Number.NEGATIVE_INFINITY;
    if (Date.now() > Math.max(baseEnd, extendedEnd)) return json({ error: "Exam time has expired." }, 409);

    const bytes = decodeBase64(audioBase64);
    if (bytes.byteLength > MAX_BYTES) return json({ error: "Audio clip is too large." }, 413);

    const ext = rawMime === "audio/mp4" ? "m4a" : rawMime === "audio/ogg" ? "ogg" : "webm";
    const objectPath = `${attempt.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(objectPath, bytes, {
        contentType: rawMime,
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const capturedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: inserted, error: insertError } = await admin
      .from("proctor_speech_clips")
      .insert({
        attempt_id: attempt.id,
        object_path: objectPath,
        captured_at: capturedAt,
        duration_seconds: durationSeconds || null,
        peak_level: peakLevel || null,
        mime_type: rawMime,
        byte_size: bytes.byteLength,
        prebuffer_seconds: prebufferSeconds,
        transcription_status: geminiKey ? "pending" : "failed",
        transcription_error: geminiKey ? null : "GEMINI_API_KEY is not configured.",
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (insertError) {
      await admin.storage.from(BUCKET).remove([objectPath]);
      throw insertError;
    }

    let transcript = "";
    let language = "";
    let status = geminiKey ? "pending" : "failed";
    let transcriptionError = geminiKey ? "" : "GEMINI_API_KEY is not configured.";

    if (geminiKey) {
      try {
        const result = await transcribeWithGemini(bytes, rawMime, geminiKey, geminiModel);
        transcript = String(result.transcript || "").trim().slice(0, 12000);
        language = String(result.language || "").trim().slice(0, 80);
        status = result.speech_detected === false || !transcript ? "no_speech" : "completed";
      } catch (error) {
        console.error("speech transcription error", error);
        status = "failed";
        transcriptionError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      }

      const { error: updateError } = await admin
        .from("proctor_speech_clips")
        .update({
          transcript: transcript || null,
          transcription_language: language || null,
          transcription_status: status,
          transcription_error: transcriptionError || null,
        })
        .eq("id", inserted.id);
      if (updateError) console.error("speech transcript storage error", updateError);
    }

    return json({
      ok: true,
      clip_id: inserted.id,
      captured_at: capturedAt,
      expires_at: expiresAt,
      transcription_status: status,
      transcript: transcript || null,
      transcription_language: language || null,
    });
  } catch (error) {
    console.error("capture-speech-clip error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function transcribeWithGemini(
  bytes: Uint8Array,
  mimeType: string,
  apiKey: string,
  model: string,
) {
  const prompt = [
    "Transcribe the attached short exam-room audio clip as faithfully as possible.",
    "Preserve the spoken language and code-switching, including English and Filipino.",
    "Do not guess words that are unclear; use [inaudible] when necessary.",
    "Do not add explanations, judgments, cheating conclusions, or speaker identity.",
    "Return JSON only with: transcript (string), language (short string), speech_detected (boolean).",
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: encodeBase64(bytes) } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              transcript: { type: "STRING" },
              language: { type: "STRING" },
              speech_detected: { type: "BOOLEAN" },
            },
            required: ["transcript", "language", "speech_detected"],
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini transcription failed (${response.status}): ${safeUpstreamError(detail)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((p: any) => typeof p?.text === "string" ? p.text : "")
    .join("\n")
    .trim();

  if (!text) throw new Error("Gemini returned no transcription text.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini returned an unreadable transcription response.");
  }
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function safeUpstreamError(detail: string): string {
  try {
    const parsed = JSON.parse(detail);
    return String(parsed?.error?.message || parsed?.message || "Upstream error").slice(0, 400);
  } catch {
    return String(detail || "Upstream error").replace(/[\r\n]+/g, " ").slice(0, 400);
  }
}

function getSupabaseAdminKey(): string {
  const modern = String(Deno.env.get("SUPABASE_SECRET_KEYS") || "").trim();
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (Array.isArray(parsed)) {
        const key = parsed.find((v) => typeof v === "string" && v.trim());
        if (key) return key.trim();
      }
      if (typeof parsed === "object" && parsed) {
        const values = Object.values(parsed).filter((v) => typeof v === "string" && String(v).trim());
        if (values.length) return String(values[0]).trim();
      }
    } catch {
      if (modern.startsWith("ey") || modern.startsWith("sb_secret_")) return modern;
    }
  }
  return String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
