import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cleanup-secret",
};

const BUCKET = "exam-proctor-photos";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const expected = String(Deno.env.get("PROCTOR_CLEANUP_SECRET") || "").trim();
  const supplied = String(req.headers.get("x-cleanup-secret") || "").trim();
  if (!expected || supplied !== expected) return json({ error: "Unauthorized." }, 401);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getSupabaseAdminKey();
    if (!supabaseUrl || !serviceKey) return json({ error: "Supabase server configuration is incomplete." }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Query Storage metadata so cleanup also removes orphaned objects if an
    // attempt was deleted before its 24-hour photo-retention period elapsed.
    const { data: expiredObjects, error: objectError } = await admin
      .schema("storage")
      .from("objects")
      .select("name,created_at")
      .eq("bucket_id", BUCKET)
      .lte("created_at", cutoff)
      .limit(1000);

    if (objectError) throw objectError;
    const paths = (expiredObjects || []).map((r) => String(r.name || "")).filter(Boolean);
    if (!paths.length) return json({ ok: true, deleted: 0 });

    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
    if (removeError) throw removeError;

    // Metadata rows normally disappear here as well. Delete explicitly in case
    // a row remains after a partial earlier cleanup.
    const { error: deleteError } = await admin
      .from("proctor_photos")
      .delete()
      .in("object_path", paths);
    if (deleteError) throw deleteError;

    return json({ ok: true, deleted: paths.length });
  } catch (error) {
    console.error("cleanup-proctor-photos error", error);
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
