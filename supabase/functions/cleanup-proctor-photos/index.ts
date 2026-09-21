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

    const now = new Date().toISOString();
    const { data: expired, error } = await admin
      .from("proctor_photos")
      .select("id,object_path")
      .lte("expires_at", now)
      .limit(1000);

    if (error) throw error;
    const rows = expired || [];
    if (!rows.length) return json({ ok: true, deleted: 0 });

    const paths = rows.map((r) => r.object_path);
    const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
    if (removeError) throw removeError;

    const ids = rows.map((r) => r.id);
    const { error: deleteError } = await admin.from("proctor_photos").delete().in("id", ids);
    if (deleteError) throw deleteError;

    return json({ ok: true, deleted: rows.length });
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
