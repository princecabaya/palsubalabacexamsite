import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "exam-proctor-photos";
const MAX_BYTES = 600_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const attemptToken = String(body?.attempt_token || "").trim();
    const imageBase64 = String(body?.image_base64 || "").trim();

    if (!/^[0-9a-f-]{36}$/i.test(attemptToken)) {
      return json({ error: "Invalid attempt token." }, 400);
    }
    if (!imageBase64) return json({ error: "Photo data is required." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getSupabaseAdminKey();
    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Supabase server configuration is incomplete." }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: attempt, error: attemptError } = await admin
      .from("attempts")
      .select("id,status,started_at,exam_id,exams(duration_minutes,end_at)")
      .eq("attempt_token", attemptToken)
      .maybeSingle();

    if (attemptError) throw attemptError;
    if (!attempt) return json({ error: "Exam attempt not found." }, 404);
    if (attempt.status !== "active") return json({ error: "Exam attempt is not active." }, 409);

    const exam = Array.isArray(attempt.exams) ? attempt.exams[0] : attempt.exams;
    const durationMs = Number(exam?.duration_minutes || 0) * 60_000;
    const attemptEnd = new Date(attempt.started_at).getTime() + durationMs;
    const scheduledEnd = exam?.end_at ? new Date(exam.end_at).getTime() : Number.POSITIVE_INFINITY;
    if (Date.now() > Math.min(attemptEnd, scheduledEnd)) {
      return json({ error: "Exam time has expired." }, 409);
    }

    const bytes = decodeBase64Image(imageBase64);
    if (bytes.byteLength > MAX_BYTES) {
      return json({ error: "Photo is too large." }, 413);
    }

    const objectPath = `${attempt.id}/${Date.now()}-${crypto.randomUUID()}.jpg`;
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(objectPath, bytes, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const capturedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: metaError } = await admin
      .from("proctor_photos")
      .insert({
        attempt_id: attempt.id,
        object_path: objectPath,
        captured_at: capturedAt,
        expires_at: expiresAt,
      });

    if (metaError) {
      await admin.storage.from(BUCKET).remove([objectPath]);
      throw metaError;
    }

    return json({ ok: true, captured_at: capturedAt, expires_at: expiresAt });
  } catch (error) {
    console.error("capture-proctor-photo error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function decodeBase64Image(value: string): Uint8Array {
  const raw = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
