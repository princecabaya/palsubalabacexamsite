import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { S3Client, DeleteObjectCommand } from "npm:@aws-sdk/client-s3@3.922.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PHOTO_BUCKET = "exam-proctor-photos";
const AUDIO_BUCKET = "exam-proctor-audio";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const accessToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const body = await req.json().catch(() => ({}));
    const attemptId = String(body?.attempt_id || "").trim();
    const mediaType = String(body?.media_type || "").trim();
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body.ids.map((v: unknown) => String(v || "").trim()).filter(Boolean))]
      : [];

    if (!accessToken) return json({ error: "Teacher authentication required." }, 401);
    if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return json({ error: "Invalid attempt ID." }, 400);
    if (!["photo", "audio"].includes(mediaType)) return json({ error: "Invalid media type." }, 400);
    if (!ids.length || ids.length > 100) return json({ error: "Select between 1 and 100 media files." }, 400);
    if (ids.some((id: string) => !/^[0-9a-f-]{36}$/i.test(id))) return json({ error: "Invalid media ID." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = getAdminKey();
    if (!supabaseUrl || !serviceKey) return json({ error: "Supabase server configuration is incomplete." }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !userData?.user) return json({ error: "Teacher session is invalid." }, 401);
    const userId = userData.user.id;

    const { data: profile, error: profileError } = await admin
      .from("exam_admins")
      .select("role,is_admin")
      .eq("user_id", userId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.is_admin) return json({ error: "Teacher access required." }, 403);

    const { data: attempt, error: attemptError } = await admin
      .from("attempts")
      .select("id,exam_id,exams(owner_id)")
      .eq("id", attemptId)
      .maybeSingle();
    if (attemptError) throw attemptError;
    if (!attempt) return json({ error: "Attempt not found." }, 404);

    const exam = Array.isArray(attempt.exams) ? attempt.exams[0] : attempt.exams;
    const canDelete = profile.role === "main_admin" || exam?.owner_id === userId;
    if (!canDelete) return json({ error: "Only the exam owner or Main Admin may delete proctor media." }, 403);

    const table = mediaType === "photo" ? "proctor_photos" : "proctor_speech_clips";
    const bucket = mediaType === "photo" ? PHOTO_BUCKET : AUDIO_BUCKET;

    const { data: rows, error: rowsError } = await admin
      .from(table)
      .select("id,object_path,storage_provider,evidence_saved")
      .eq("attempt_id", attemptId)
      .in("id", ids);
    if (rowsError) throw rowsError;

    const foundIds = new Set((rows || []).map((row: any) => row.id));
    const missing = ids.filter((id: string) => !foundIds.has(id));
    const protectedIds = (rows || []).filter((row: any) => row.evidence_saved).map((row: any) => row.id);
    const candidates = (rows || []).filter((row: any) => !row.evidence_saved);

    const deletedIds: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    const s3 = createR2Client();

    try {
      for (const row of candidates) {
        const path = String(row.object_path || "").trim();
        if (!path) {
          failed.push({ id: row.id, message: "Missing object path." });
          continue;
        }

        try {
          if (row.storage_provider === "r2") {
            if (!s3) throw new Error("R2 storage is not configured.");
            await s3.send(new DeleteObjectCommand({
              Bucket: String(Deno.env.get("R2_BUCKET") || "").trim(),
              Key: path,
            }));
          } else {
            const { error: removeError } = await admin.storage.from(bucket).remove([path]);
            if (removeError) throw removeError;
          }

          const { error: rowDeleteError } = await admin
            .from(table)
            .delete()
            .eq("id", row.id)
            .eq("attempt_id", attemptId)
            .eq("evidence_saved", false);
          if (rowDeleteError) throw rowDeleteError;

          deletedIds.push(row.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("delete-proctor-media item failed", {
            mediaType,
            id: row.id,
            storage_provider: row.storage_provider,
            object_path: path,
            message,
          });
          failed.push({ id: row.id, message: message.slice(0, 200) });
        }
      }
    } finally {
      s3?.destroy();
    }

    return json({
      ok: failed.length === 0,
      deleted: deletedIds,
      protected: protectedIds,
      missing,
      failed,
    }, 200);
  } catch (error) {
    console.error("delete-proctor-media error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function createR2Client(): S3Client | null {
  const account = String(Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const endpointSecret = String(Deno.env.get("R2_ENDPOINT") || "").trim().replace(/\/+$/, "");
  const bucket = String(Deno.env.get("R2_BUCKET") || "").trim();
  const accessKeyId = String(Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = String(Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();

  if ((!account && !endpointSecret) || !bucket || !accessKeyId || !secretAccessKey) return null;

  return new S3Client({
    region: "auto",
    endpoint: endpointSecret || `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getAdminKey(): string {
  const modern = String(Deno.env.get("SUPABASE_SECRET_KEYS") || "").trim();
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (Array.isArray(parsed)) {
        const key = parsed.find((value) => typeof value === "string" && value.trim());
        if (key) return key.trim();
      }
      if (parsed && typeof parsed === "object") {
        const key = Object.values(parsed).find((value) => typeof value === "string" && String(value).trim());
        if (key) return String(key).trim();
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
