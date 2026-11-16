import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

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

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Query Storage metadata so cleanup also removes orphaned objects if an
    // attempt was deleted before its 7-day photo-retention period elapsed.
    const { data: expiredObjects, error: objectError } = await admin
      .schema("storage")
      .from("objects")
      .select("name,created_at")
      .eq("bucket_id", BUCKET)
      .lte("created_at", cutoff)
      .limit(1000);

    if (objectError) throw objectError;
    const candidatePaths = (expiredObjects || []).map((r) => String(r.name || "")).filter(Boolean);
    if (!candidatePaths.length) return json({ ok: true, deleted: 0 });

    const { data: protectedRows, error: protectedError } = await admin
      .from("proctor_photos")
      .select("object_path")
      .in("object_path", candidatePaths)
      .eq("evidence_saved", true);

    if (protectedError) throw protectedError;
    const protectedPaths = new Set((protectedRows || []).map((r) => String(r.object_path)));
    const paths = candidatePaths.filter((p) => !protectedPaths.has(p));
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

    let r2Deleted = 0;
    if (r2Configured()) {
      const { data: r2Rows, error: r2RowsError } = await admin
        .from("proctor_photos")
        .select("id,object_path")
        .eq("storage_provider", "r2")
        .eq("evidence_saved", false)
        .lt("expires_at", new Date().toISOString())
        .limit(500);

      if (r2RowsError) throw r2RowsError;

      const deletedIds = [];
      for (let i = 0; i < (r2Rows || []).length; i += 20) {
        const chunk = (r2Rows || []).slice(i, i + 20);
        const results = await Promise.all(chunk.map(async (row) => {
          try {
            await r2Delete(String(row.object_path || ""));
            return row.id;
          } catch (error) {
            console.error("R2 photo cleanup failed", row.object_path, error);
            return null;
          }
        }));
        deletedIds.push(...results.filter(Boolean));
      }

      if (deletedIds.length) {
        const { error: r2DeleteRowsError } = await admin
          .from("proctor_photos")
          .delete()
          .in("id", deletedIds)
          .eq("storage_provider", "r2")
          .eq("evidence_saved", false);
        if (r2DeleteRowsError) throw r2DeleteRowsError;
        r2Deleted = deletedIds.length;
      }
    }

    return json({ ok: true, deleted: paths.length + r2Deleted, supabase_deleted: paths.length, r2_deleted: r2Deleted });
  } catch (error) {
    console.error("cleanup-proctor-photos error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function r2Configured(): boolean {
  return Boolean(
    String(Deno.env.get("R2_ACCOUNT_ID") || "").trim() &&
    String(Deno.env.get("R2_ACCESS_KEY_ID") || "").trim() &&
    String(Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim() &&
    String(Deno.env.get("R2_BUCKET") || "").trim()
  );
}

function r2Client() {
  return new AwsClient({
    accessKeyId: String(Deno.env.get("R2_ACCESS_KEY_ID") || "").trim(),
    secretAccessKey: String(Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim(),
    service: "s3",
    region: "auto",
  });
}

function r2ObjectUrl(path: string): string {
  const account = String(Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const bucket = String(Deno.env.get("R2_BUCKET") || "").trim();
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://${account}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encoded}`;
}

async function r2Delete(path: string) {
  const response = await r2Client().fetch(r2ObjectUrl(path), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 delete failed (${response.status}): ${(await response.text()).slice(0,300)}`);
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
