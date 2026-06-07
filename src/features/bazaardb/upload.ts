import type { Env } from "../../env";
import { json, jsonError, requestMediaType } from "../../http/json";
import { declaredContentLengthExceeds, objectKeySegment } from "../../http/request";
import { logInfo, logWarn } from "../../observability";
import { putThenProject } from "../../storage/putThenProject";

const MaxSnapshotBodyBytes = 4 * 1024 * 1024;

async function snapshotExists(
  env: Env,
  snapshotId: string,
): Promise<{ uploaded_at_utc: string; r2_key: string } | null> {
  return env.DB.prepare(
    "SELECT uploaded_at_utc, r2_key FROM bazaardb_delivery WHERE snapshot_id = ? LIMIT 1",
  )
    .bind(snapshotId)
    .first<{ uploaded_at_utc: string; r2_key: string }>();
}

function ok(snapshotId: string, uploadedAtUtc: string): Response {
  return json({ status: "ok", snapshot_id: snapshotId, uploaded_at_utc: uploadedAtUtc });
}

function validateSnapshotBodyId(body: Uint8Array, expectedSnapshotId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "invalid_snapshot_body";
  }

  if (typeof parsed !== "object" || parsed == null) {
    return "invalid_snapshot_body";
  }

  const snapshot = (parsed as Record<string, unknown>).snapshot;
  if (typeof snapshot !== "object" || snapshot == null) {
    return "invalid_snapshot_body";
  }

  const bodySnapshotId = (snapshot as Record<string, unknown>).id;
  if (typeof bodySnapshotId !== "string" || bodySnapshotId.trim() !== expectedSnapshotId) {
    return "snapshot_id_mismatch";
  }

  return null;
}

export async function handleUploadBazaarDbSnapshot(
  request: Request,
  env: Env,
  snapshotId: string,
): Promise<Response> {
  const phaseStart = Date.now();
  const normalizedSnapshotId = snapshotId.trim();
  if (objectKeySegment(normalizedSnapshotId) == null) {
    return jsonError("invalid_snapshot_id");
  }

  const existing = await snapshotExists(env, normalizedSnapshotId);
  if (existing) {
    return ok(normalizedSnapshotId, existing.uploaded_at_utc);
  }

  if (requestMediaType(request) !== "application/json") {
    return jsonError("unsupported_content_type");
  }

  if (declaredContentLengthExceeds(request, MaxSnapshotBodyBytes)) {
    return jsonError("payload_too_large", 413);
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return jsonError("payload_too_large", 413);
  }
  if (body.byteLength > MaxSnapshotBodyBytes) {
    return jsonError("payload_too_large", 413);
  }
  const bodyError = validateSnapshotBodyId(body, normalizedSnapshotId);
  if (bodyError != null) {
    return jsonError(bodyError);
  }

  const uploadId = crypto.randomUUID();
  const r2Key = `bazaardb/snapshots/${normalizedSnapshotId}/${uploadId}.json`;
  const r2Start = Date.now();
  let r2PutMs = 0;

  const uploadedAtUtc = new Date().toISOString();
  let d1InsertMs = 0;
  const projectResult = await putThenProject({
    bucket: env.BAZAARDB_BUCKET,
    objectKey: r2Key,
    value: body,
    putOptions: { httpMetadata: { contentType: "application/json" } },
    project: async () => {
      const d1Start = Date.now();
      const result = await env.DB.prepare(
        `
          INSERT INTO bazaardb_delivery (
            snapshot_id, r2_key, content_type, body_bytes,
            delivery_state, uploaded_at_utc, state_updated_at_utc
          ) VALUES (?, ?, 'application/json', ?, 'pending', ?, ?)
        `,
      )
        .bind(normalizedSnapshotId, r2Key, body.byteLength, uploadedAtUtc, uploadedAtUtc)
        .run();
      d1InsertMs = Date.now() - d1Start;
      return result;
    },
    findCommitted: () => snapshotExists(env, normalizedSnapshotId),
    isObjectReferenced: (committed) => committed.r2_key === r2Key,
    onPutSucceeded: () => {
      r2PutMs = Date.now() - r2Start;
    },
  });

  if (!projectResult.ok) {
    switch (projectResult.cleanup) {
      case "kept":
        logWarn("bazaardb.snapshot_upload", {
          snapshot_id: normalizedSnapshotId,
          r2_key: r2Key,
          error: String(projectResult.error),
          outcome: "d1_insert_failed_existing_object_kept",
        });
        break;
      case "deleted":
        logWarn("bazaardb.snapshot_upload", {
          snapshot_id: normalizedSnapshotId,
          r2_key: r2Key,
          error: String(projectResult.error),
          outcome: "d1_insert_failed_r2_cleaned",
        });
        break;
      case "orphaned":
        logWarn("bazaardb.snapshot_upload", {
          snapshot_id: normalizedSnapshotId,
          r2_key: r2Key,
          error: String(projectResult.error),
          cleanup_error: String(projectResult.cleanupError),
          outcome: "d1_insert_failed_r2_orphaned",
        });
        break;
      case "reference_lookup_failed":
        logWarn("bazaardb.snapshot_upload", {
          snapshot_id: normalizedSnapshotId,
          r2_key: r2Key,
          error: String(projectResult.error),
          reference_lookup_error: String(projectResult.referenceLookupError),
          outcome: "d1_insert_failed_reference_lookup_failed",
        });
        break;
    }

    const racedExisting = projectResult.committed;
    if (racedExisting) {
      return ok(normalizedSnapshotId, racedExisting.uploaded_at_utc);
    }

    logWarn("bazaardb.snapshot_upload", {
      snapshot_id: normalizedSnapshotId,
      r2_key: r2Key,
      error: String(projectResult.error),
      outcome: "d1_insert_failed",
    });
    return jsonError("db_insert_failed", 500);
  }
  logInfo("bazaardb.snapshot_upload", {
    snapshot_id: normalizedSnapshotId,
    r2_key: r2Key,
    body_bytes: body.byteLength,
    phase_ms: { r2_put: r2PutMs, d1_insert: d1InsertMs, total: Date.now() - phaseStart },
    outcome: "ok",
  });

  return ok(normalizedSnapshotId, uploadedAtUtc);
}
