import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = "exam-proctor-audio";

Deno.serve(async (req) => {
  const key = req.headers.get("x-cleanup-key") || "";
  const expected = Deno.env.get("PROCTOR_CLEANUP_KEY") || "";
  if (!expected || key !== expected) return new Response("Unauthorized", { status: 401 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = getSupabaseAdminKey();
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const now = new Date().toISOString();
  const { data: expired, error } = await admin
    .from("proctor_speech_clips")
    .select("id,object_path")
    .lt("expires_at", now)
    .eq("evidence_saved", false)
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });

  const paths = (expired || []).map((r) => r.object_path);
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);

  const ids = (expired || []).map((r) => r.id);
  if (ids.length) await admin.from("proctor_speech_clips").delete().in("id", ids);

  return new Response(JSON.stringify({ deleted: ids.length }), {
    headers: { "Content-Type": "application/json" },
  });
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
