import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  const photoCutoff = new Date(Date.now() - PHOTO_RETENTION_DAYS * 86400000).toISOString();
  const audioCutoff = new Date(Date.now() - AUDIO_RETENTION_DAYS * 86400000).toISOString();

  const [{ data: photoObjects, error: photoObjectError }, { data: audioObjects, error: audioObjectError }] =
    await Promise.all([
      admin.schema("storage").from("objects")
        .select("name,metadata,created_at")
        .eq("bucket_id", PHOTO_BUCKET)
        .lte("created_at", photoCutoff)
        .limit(1000),
      admin.schema("storage").from("objects")
        .select("name,metadata,created_at")
        .eq("bucket_id", AUDIO_BUCKET)
        .lte("created_at", audioCutoff)
        .limit(1000),
    ]);

  if (photoObjectError) throw photoObjectError;
  if (audioObjectError) throw audioObjectError;

  const { count: photoRows, error: photoCountError } = await admin
    .from("proctor_photos")
    .select("id", { count: "exact", head: true })
    .eq("evidence_saved", false)
    .lt("expires_at", new Date().toISOString());

  const { count: audioRows, error: audioCountError } = await admin
    .from("proctor_speech_clips")
    .select("id", { count: "exact", head: true })
    .eq("evidence_saved", false)
    .lt("expires_at", new Date().toISOString());

  if (photoCountError) throw photoCountError;
  if (audioCountError) throw audioCountError;

  return {
    ok: true,
    expired: {
      photos: Number(photoRows || 0),
      audio: Number(audioRows || 0),
    },
    sample: {
      photo_objects_older_than_7d: (photoObjects || []).length,
      photo_bytes_first_1000: sumBytes(photoObjects || []),
      audio_objects_older_than_7d: (audioObjects || []).length,
      audio_bytes_first_1000: sumBytes(audioObjects || []),
    },
    retention_days: 7,
  };
}

async function cleanupPhotos(admin: any, limit: number) {
  const cutoff = new Date(Date.now() - PHOTO_RETENTION_DAYS * 86400000).toISOString();

  const { data: objects, error } = await admin.schema("storage").from("objects")
    .select("name,metadata")
    .eq("bucket_id", PHOTO_BUCKET)
    .lte("created_at", cutoff)
    .limit(limit);

  if (error) throw error;
  const candidates = objects || [];
  if (!candidates.length) return { deleted: 0, bytes: 0 };

  const paths = candidates.map((row: any) => String(row.name || "")).filter(Boolean);
  const { data: protectedRows, error: protectedError } = await admin
    .from("proctor_photos")
    .select("object_path")
    .in("object_path", paths)
    .eq("evidence_saved", true);

  if (protectedError) throw protectedError;

  const protectedPaths = new Set((protectedRows || []).map((row: any) => String(row.object_path)));
  const deletable = candidates.filter((row: any) => !protectedPaths.has(String(row.name)));
  const deletablePaths = deletable.map((row: any) => String(row.name));

  if (!deletablePaths.length) return { deleted: 0, bytes: 0 };

  const { error: removeError } = await admin.storage.from(PHOTO_BUCKET).remove(deletablePaths);
  if (removeError) throw removeError;

  const { error: rowDeleteError } = await admin
    .from("proctor_photos")
    .delete()
    .in("object_path", deletablePaths)
    .eq("evidence_saved", false);

  if (rowDeleteError) throw rowDeleteError;

  return { deleted: deletablePaths.length, bytes: sumBytes(deletable) };
}

async function cleanupAudio(admin: any, limit: number) {
  const now = new Date().toISOString();

  const { data: rows, error } = await admin
    .from("proctor_speech_clips")
    .select("id,object_path,byte_size")
    .eq("evidence_saved", false)
    .lt("expires_at", now)
    .limit(limit);

  if (error) throw error;
  if (!rows?.length) return { deleted: 0, bytes: 0 };

  const paths = rows.map((row: any) => String(row.object_path || "")).filter(Boolean);
  if (paths.length) {
    const { error: removeError } = await admin.storage.from(AUDIO_BUCKET).remove(paths);
    if (removeError) throw removeError;
  }

  const ids = rows.map((row: any) => row.id);
  const { error: rowDeleteError } = await admin
    .from("proctor_speech_clips")
    .delete()
    .in("id", ids)
    .eq("evidence_saved", false);

  if (rowDeleteError) throw rowDeleteError;

  return {
    deleted: ids.length,
    bytes: rows.reduce((sum: number, row: any) => sum + Number(row.byte_size || 0), 0),
  };
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
