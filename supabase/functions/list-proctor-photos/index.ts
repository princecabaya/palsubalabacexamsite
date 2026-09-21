import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "exam-proctor-photos";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const body = await req.json();
    const attemptId = String(body?.attempt_id || "").trim();

    if (!accessToken) return json({ error: "Teacher authentication required." }, 401);
    if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return json({ error: "Invalid attempt ID." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getSupabaseAdminKey();
    if (!supabaseUrl || !serviceKey) return json({ error: "Supabase server configuration is incomplete." }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !userData?.user) return json({ error: "Teacher session is invalid." }, 401);
    const userId = userData.user.id;

    const { data: profile } = await admin
      .from("exam_admins")
      .select("role,is_admin")
      .eq("user_id", userId)
      .maybeSingle();

    if (!profile?.is_admin) return json({ error: "Teacher access required." }, 403);

    const { data: attempt, error: attemptError } = await admin
      .from("attempts")
      .select("id,exam_id,exams(owner_id)")
      .eq("id", attemptId)
      .maybeSingle();

    if (attemptError) throw attemptError;
    if (!attempt) return json({ error: "Attempt not found." }, 404);

    const exam = Array.isArray(attempt.exams) ? attempt.exams[0] : attempt.exams;
    const canAccess = profile.role === "main_admin" || exam?.owner_id === userId;
    if (!canAccess) return json({ error: "You do not have access to this attempt." }, 403);

    const { data: photos, error: photoError } = await admin
      .from("proctor_photos")
      .select("id,object_path,captured_at,expires_at")
      .eq("attempt_id", attemptId)
      .gt("expires_at", new Date().toISOString())
      .order("captured_at", { ascending: true });

    if (photoError) throw photoError;

    const output = [];
    for (const photo of photos || []) {
      const { data: signed, error: signedError } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(photo.object_path, 300);
      if (signedError) continue;
      output.push({
        id: photo.id,
        captured_at: photo.captured_at,
        expires_at: photo.expires_at,
        url: signed.signedUrl,
      });
    }

    return json({ photos: output });
  } catch (error) {
    console.error("list-proctor-photos error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

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
