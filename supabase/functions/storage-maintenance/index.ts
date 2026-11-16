import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "npm:@aws-sdk/client-s3@3.922.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PHOTO_BUCKET = "exam-proctor-photos";
const AUDIO_BUCKET = "exam-proctor-audio";
const PHOTO_RETENTION_DAYS = 7;
const AUDIO_RETENTION_DAYS = 7;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Main Admin authentication required." }, 401);

    const url = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = getAdminKey();
    if (!url || !serviceKey) return json({ error: "Supabase server configuration is incomplete." }, 500);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData?.user) return json({ error: "Invalid teacher session." }, 401);

    const { data: profile, error: profileError } = await admin
      .from("exam_admins")
      .select("is_admin,role")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile?.is_admin || profile.role !== "main_admin") {
      return json({ error: "Only the Main Admin may clean Supabase Storage." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "status");
    const maxBatches = Math.max(1, Math.min(10, Number(body?.max_batches || 5)));

    if (mode === "status") {
      return json(await getStatus(admin));
    }

    if (mode !== "cleanup") return json({ error: "Invalid cleanup mode." }, 400);

    let photoDeleted = 0;
    let audioDeleted = 0;
    let photoBytes = 0;
    let audioBytes = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await cleanupPhotos(admin, 1000);
      photoDeleted += result.deleted;
      photoBytes += result.bytes;
      if (result.deleted < 1000) break;
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await cleanupAudio(admin, 1000);
      audioDeleted += result.deleted;
      audioBytes += result.bytes;
      if (result.deleted < 1000) break;
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await cleanupR2Rows(admin, "proctor_photos", 250);
      photoDeleted += result.deleted;
      photoBytes += result.bytes;
      if (result.deleted < 250) break;
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await cleanupR2Rows(admin, "proctor_speech_clips", 250);
      audioDeleted += result.deleted;
      audioBytes += result.bytes;
      if (result.deleted < 250) break;
    }

    const status = await getStatus(admin);

    return json({
      ok: true,
      deleted: {
        photos: photoDeleted,
        audio: audioDeleted,
        total: photoDeleted + audioDeleted,
        bytes: photoBytes + audioBytes,
      },
      status,
    });
  } catch (error) {
    console.error("storage-maintenance error", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

async function getStatus(admin: any) {
  const now = new Date().toISOString();

  const [{ count: photoRows, error: photoCountError }, { count: audioRows, error: audioCountError }] =
    await Promise.all([
      admin
        .from("proctor_photos")
        .select("id", { count: "exact", head: true })
        .eq("evidence_saved", false)
        .lt("expires_at", now),
      admin
        .from("proctor_speech_clips")
        .select("id", { count: "exact", head: true })
        .eq("evidence_saved", false)
        .lt("expires_at", now),
    ]);

  if (photoCountError) throw photoCountError;
  if (audioCountError) throw audioCountError;

  const r2 = await getR2Status();

  return {
    ok: true,
    expired: {
      photos: Number(photoRows || 0),
      audio: Number(audioRows || 0),
    },
    r2,
    retention_days: 7,
  };
}

async function cleanupPhotos(admin: any, limit: number) {
  const { data: rows, error } = await admin
    .from("proctor_photos")
    .select("id,object_path,byte_size,storage_provider")
    .eq("evidence_saved", false)
    .eq("storage_provider", "supabase")
    .lt("expires_at", new Date().toISOString())
    .limit(limit);

  if (error) throw error;
  if (!rows?.length) return { deleted: 0, bytes: 0 };

  const deletedIds: string[] = [];
  let bytes = 0;

  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const chunkPaths = chunk.map((row: any) => String(row.object_path || "")).filter(Boolean);

    if (!chunkPaths.length) continue;

    const { error: chunkError } = await admin.storage.from(PHOTO_BUCKET).remove(chunkPaths);
    if (!chunkError) {
      for (const row of chunk) {
        if (row.object_path) {
          deletedIds.push(row.id);
          bytes += Number(row.byte_size || 0);
        }
      }
      continue;
    }

    console.warn("cleanupPhotos chunk delete failed; retrying individually", chunkError);

    for (const row of chunk) {
      const path = String(row.object_path || "").trim();
      if (!path) {
        console.warn("cleanupPhotos skipping empty object path", row.id);
        continue;
      }

      const { error: singleError } = await admin.storage.from(PHOTO_BUCKET).remove([path]);
      if (singleError) {
        console.warn("cleanupPhotos object delete skipped", {
          id: row.id,
          path,
          message: singleError.message,
        });
        continue;
      }

      deletedIds.push(row.id);
      bytes += Number(row.byte_size || 0);
    }
  }

  if (deletedIds.length) {
    for (let i = 0; i < deletedIds.length; i += 500) {
      const ids = deletedIds.slice(i, i + 500);
      const { error: rowDeleteError } = await admin
        .from("proctor_photos")
        .delete()
        .in("id", ids)
        .eq("storage_provider", "supabase")
        .eq("evidence_saved", false);
      if (rowDeleteError) throw rowDeleteError;
    }
  }

  return { deleted: deletedIds.length, bytes };
}

async function cleanupAudio(admin: any, limit: number) {
  const { data: rows, error } = await admin
    .from("proctor_speech_clips")
    .select("id,object_path,byte_size,storage_provider")
    .eq("evidence_saved", false)
    .eq("storage_provider", "supabase")
    .lt("expires_at", new Date().toISOString())
    .limit(limit);

  if (error) throw error;
  if (!rows?.length) return { deleted: 0, bytes: 0 };

  const deletedIds: string[] = [];
  let bytes = 0;

  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const chunkPaths = chunk.map((row: any) => String(row.object_path || "")).filter(Boolean);

    if (!chunkPaths.length) continue;

    const { error: chunkError } = await admin.storage.from(AUDIO_BUCKET).remove(chunkPaths);
    if (!chunkError) {
      for (const row of chunk) {
        if (row.object_path) {
          deletedIds.push(row.id);
          bytes += Number(row.byte_size || 0);
        }
      }
      continue;
    }

    console.warn("cleanupAudio chunk delete failed; retrying individually", chunkError);

    for (const row of chunk) {
      const path = String(row.object_path || "").trim();
      if (!path) {
        console.warn("cleanupAudio skipping empty object path", row.id);
        continue;
      }

      const { error: singleError } = await admin.storage.from(AUDIO_BUCKET).remove([path]);
      if (singleError) {
        console.warn("cleanupAudio object delete skipped", {
          id: row.id,
          path,
          message: singleError.message,
        });
        continue;
      }

      deletedIds.push(row.id);
      bytes += Number(row.byte_size || 0);
    }
  }

  if (deletedIds.length) {
    for (let i = 0; i < deletedIds.length; i += 500) {
      const ids = deletedIds.slice(i, i + 500);
      const { error: rowDeleteError } = await admin
        .from("proctor_speech_clips")
        .delete()
        .in("id", ids)
        .eq("storage_provider", "supabase")
        .eq("evidence_saved", false);
      if (rowDeleteError) throw rowDeleteError;
    }
  }

  return { deleted: deletedIds.length, bytes };
}

async function cleanupR2Rows(admin: any, table: string, limit: number) {
  if (!r2Configured()) return { deleted: 0, bytes: 0 };

  const selectColumns = table === "proctor_photos"
    ? "id,object_path,byte_size"
    : "id,object_path,byte_size";

  const { data: rows, error } = await admin
    .from(table)
    .select(selectColumns)
    .eq("storage_provider", "r2")
    .eq("evidence_saved", false)
    .lt("expires_at", new Date().toISOString())
    .limit(limit);

  if (error) throw error;
  if (!rows?.length) return { deleted: 0, bytes: 0 };

  const deletedIds: string[] = [];
  let bytes = 0;

  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const results = await Promise.all(chunk.map(async (row: any) => {
      try {
        await r2Delete(String(row.object_path || ""));
        return row;
      } catch (error) {
        console.error("R2 cleanup object failed", row.object_path, error);
        return null;
      }
    }));

    for (const row of results.filter(Boolean) as any[]) {
      deletedIds.push(row.id);
      bytes += Number(row.byte_size || 0);
    }
  }

  if (deletedIds.length) {
    const { error: deleteError } = await admin
      .from(table)
      .delete()
      .in("id", deletedIds)
      .eq("storage_provider", "r2")
      .eq("evidence_saved", false);
    if (deleteError) throw deleteError;
  }

  return { deleted: deletedIds.length, bytes };
}

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

function r2BaseUrl(): string {
  const account = String(Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const bucket = String(Deno.env.get("R2_BUCKET") || "").trim();
  const endpoint = String(Deno.env.get("R2_ENDPOINT") || "").trim().replace(/\/+$/,"");
  const base = endpoint || `https://${account}.r2.cloudflarestorage.com`;
  return `${base}/${encodeURIComponent(bucket)}`;
}

function r2ObjectUrl(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${r2BaseUrl()}/${encoded}`;
}

async function r2Delete(path: string) {
  const response = await r2Client().fetch(r2ObjectUrl(path), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 delete failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
}

async function getR2Status() {
  if (!r2Configured()) {
    return { configured: false, connected: false, message: "R2 secrets are not configured." };
  }

  const account = String(Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const endpointSecret = String(Deno.env.get("R2_ENDPOINT") || "").trim().replace(/\/+$/, "");
  const endpoint = endpointSecret || `https://${account}.r2.cloudflarestorage.com`;
  const bucket = String(Deno.env.get("R2_BUCKET") || "").trim();
  const accessKeyId = String(Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = String(Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();
  const key = `diagnostics/exam-guard-r2-check-${crypto.randomUUID()}.txt`;

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: new TextEncoder().encode("exam-guard-r2-ok"),
      ContentType: "text/plain",
      CacheControl: "no-store",
    }));

    await s3.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    return {
      configured: true,
      connected: true,
      bucket,
      endpoint,
      operation: "aws-sdk-put-delete",
    };
  } catch (error: any) {
    const status = Number(error?.$metadata?.httpStatusCode || 0) || undefined;
    const code = String(error?.name || error?.Code || "").slice(0, 80);
    const message = String(error?.message || error || "").slice(0, 300);

    console.error("R2 AWS SDK connectivity check failed", {
      status,
      code,
      message,
      endpoint,
      bucket,
    });

    return {
      configured: true,
      connected: false,
      status,
      code,
      operation: "aws-sdk-put-object",
      message,
    };
  } finally {
    s3.destroy();
  }
}

function sumBytes(rows: any[]) {
  return rows.reduce((sum, row) => sum + Number(row?.metadata?.size || 0), 0);
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
