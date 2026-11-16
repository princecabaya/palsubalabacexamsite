import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

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
    .select("id,object_path,storage_provider")
    .lt("expires_at", now)
    .eq("evidence_saved", false)
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });

  const supabaseRows = (expired || []).filter((r) => (r.storage_provider || "supabase") !== "r2");
  const r2Rows = (expired || []).filter((r) => r.storage_provider === "r2");

  const supabasePaths = supabaseRows.map((r) => r.object_path);
  if (supabasePaths.length) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove(supabasePaths);
    if (removeError) return new Response(removeError.message, { status: 500 });
  }

  const r2DeletedIds = [];
  for (let i = 0; i < r2Rows.length; i += 20) {
    const chunk = r2Rows.slice(i, i + 20);
    const results = await Promise.all(chunk.map(async (row) => {
      try {
        await r2Delete(String(row.object_path || ""));
        return row.id;
      } catch (error) {
        console.error("R2 audio cleanup failed", row.object_path, error);
        return null;
      }
    }));
    r2DeletedIds.push(...results.filter(Boolean));
  }

  const ids = [
    ...supabaseRows.map((r) => r.id),
    ...r2DeletedIds,
  ];
  if (ids.length) await admin.from("proctor_speech_clips").delete().in("id", ids);

  return new Response(JSON.stringify({
    deleted: ids.length,
    supabase_deleted: supabaseRows.length,
    r2_deleted: r2DeletedIds.length,
  }), {
    headers: { "Content-Type": "application/json" },
  });
});

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
  if (!account || !bucket) throw new Error("R2 storage is not configured.");
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
