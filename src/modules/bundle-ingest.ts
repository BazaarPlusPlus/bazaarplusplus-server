import type { Env } from "../env";
import { MAX_BUNDLE_BYTES } from "../domain/limits";
import type { HandlerDeps } from "../http/deps";
import { HttpError } from "../http/errors";
import { logError, logEvent } from "../observability";
import { toHex } from "../bundle/hex";
import type { ValidatedBundleDescriptor } from "../bundle/manifest";
import { openBundle, type OpenedBundle } from "../bundle/open";

interface BundleReceipt {
  bundle_id: string;
  run_id: string;
  outcome: "stored" | "duplicate";
  bazaardb_delivery: "created" | "existing" | "not_applicable";
}

interface ExistingBundleRow {
  bundle_id: string;
  run_id: string;
  bundle_sha256: string;
  has_screenshot: number;
}

function parseContentDigest(value: string | null): string {
  const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(value ?? "");
  if (match === null) {
    throw new HttpError(
      400,
      "invalid_content_digest",
      "Content-Digest must contain exactly one sha-256 value",
      false,
    );
  }
  try {
    const binary = atob(match[1]);
    if (binary.length !== 32) throw new Error("wrong digest length");
    return toHex(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    throw new HttpError(400, "invalid_content_digest", "Content-Digest is invalid", false);
  }
}

function parseContentLength(value: string | null): number {
  if (value === null) {
    throw new HttpError(
      411,
      "content_length_required",
      "Content-Length is required",
      false,
    );
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid", false);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length is invalid", false);
  }
  if (length >= MAX_BUNDLE_BYTES + 1) {
    throw new HttpError(413, "bundle_too_large", "Bundle reaches the 8 MiB limit", false);
  }
  return length;
}

async function existingByBundleId(
  env: Env,
  bundleId: string,
): Promise<ExistingBundleRow | null> {
  return env.DB.prepare(
    `SELECT bundle_id, run_id, bundle_sha256, has_screenshot FROM bundles WHERE bundle_id = ?1`,
  )
    .bind(bundleId)
    .first<ExistingBundleRow>();
}

async function bundleForRun(env: Env, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT bundle_id FROM bundles WHERE run_id = ?1`)
    .bind(runId)
    .first<{ bundle_id: string }>();
  return row?.bundle_id ?? null;
}

function duplicateReceipt(row: ExistingBundleRow): BundleReceipt {
  return {
    bundle_id: row.bundle_id,
    run_id: row.run_id,
    outcome: "duplicate",
    bazaardb_delivery: row.has_screenshot === 1 ? "existing" : "not_applicable",
  };
}

async function precheck(
  env: Env,
  descriptor: ValidatedBundleDescriptor,
  digest: string,
): Promise<BundleReceipt | null> {
  let bundle: ExistingBundleRow | null;
  let runBundle: string | null;
  try {
    [bundle, runBundle] = await Promise.all([
      existingByBundleId(env, descriptor.bundleId),
      bundleForRun(env, descriptor.runId),
    ]);
  } catch {
    throw new HttpError(503, "storage_unavailable", "Bundle index is unavailable", true);
  }
  if (bundle !== null) {
    if (bundle.bundle_sha256 !== digest) {
      throw new HttpError(409, "bundle_id_conflict", "Bundle ID already has different bytes", false);
    }
    return duplicateReceipt(bundle);
  }
  if (runBundle !== null && runBundle !== descriptor.bundleId) {
    throw new HttpError(409, "run_already_bundled", "Run already belongs to another Bundle", false);
  }
  return null;
}

async function validateExistingObject(
  env: Env,
  key: string,
  incomingDigest: string,
  incomingBundleId: string,
): Promise<number> {
  const object = await env.BUNDLE_BUCKET.get(key);
  if (object === null) {
    throw new HttpError(503, "storage_unavailable", "Conditional R2 conflict object disappeared", true);
  }
  try {
    const opened = await openBundle(object.body, object.size, null);
    await opened.body.pipeTo(new WritableStream<Uint8Array>());
    const digest = await opened.digest;
    if (opened.descriptor.bundleId !== incomingBundleId || digest !== incomingDigest) {
      throw new HttpError(409, "bundle_id_conflict", "Bundle ID already has different bytes", false);
    }
    return object.uploaded.getTime();
  } catch (error) {
    if (error instanceof HttpError && error.code === "bundle_id_conflict") throw error;
    logError("bundle.orphan.invalid", { object_key: key, reason: "existing_object_invalid" });
    throw new HttpError(503, "storage_unavailable", "Existing Bundle object is invalid", true);
  }
}

async function putConditionally(
  env: Env,
  opened: OpenedBundle,
  digest: string,
): Promise<{ created: boolean; storedAtMs: number }> {
  const descriptor = opened.descriptor;
  const fixed = new FixedLengthStream(descriptor.objectBytes);
  const pump = opened.body.pipeTo(fixed.writable);
  void pump.catch(() => undefined);
  let object: R2Object | null;
  try {
    object = await env.BUNDLE_BUCKET.put(descriptor.objectKey, fixed.readable, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/x-bpp-bundle-v5" },
      customMetadata: {
        bundle_version: "5",
        manifest_length: String(descriptor.manifestBytes),
        bundle_sha256: digest,
      },
    });
  } catch (putError) {
    await fixed.readable.cancel(putError).catch(() => undefined);
    const pumpError = await pump.then(
      () => null,
      (error: unknown) => error,
    );
    if (pumpError instanceof HttpError) {
      const candidate = await env.BUNDLE_BUCKET.head(descriptor.objectKey).catch(() => null);
      if (candidate?.customMetadata?.bundle_sha256 === digest) {
        await env.BUNDLE_BUCKET.delete(descriptor.objectKey).catch(() => undefined);
      }
      throw pumpError;
    }
    throw new HttpError(503, "storage_unavailable", "R2 Bundle write failed", true);
  }

  if (object === null) {
    await fixed.readable.cancel("conditional R2 conflict").catch(() => undefined);
    await pump.catch(() => undefined);
    const storedAtMs = await validateExistingObject(
      env,
      descriptor.objectKey,
      digest,
      descriptor.bundleId,
    );
    return { created: false, storedAtMs };
  }

  try {
    await pump;
    await opened.digest;
    return { created: true, storedAtMs: object.uploaded.getTime() };
  } catch (error) {
    await env.BUNDLE_BUCKET.delete(descriptor.objectKey).catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "storage_unavailable", "R2 Bundle streaming failed", true);
  }
}

async function commitDescriptor(
  env: Env,
  descriptor: ValidatedBundleDescriptor,
  digest: string,
  availableAt: number,
  storedAt = availableAt,
): Promise<void> {
  const screenshot = descriptor.screenshot;
  const statements = [
    env.DB.prepare(
      `INSERT INTO bundles (
        bundle_id, run_id, uploader_account_id, object_key, bundle_sha256,
        bundle_version, manifest_bytes, object_bytes, client_created_at_ms,
        stored_at_ms, available_at_ms, run_format_version, run_bytes, run_sha256,
        has_screenshot, screenshot_content_type, screenshot_bytes, screenshot_sha256
      ) VALUES (?1, ?2, ?3, ?4, ?5, 5, ?6, ?7, ?8, ?9, ?10, 5, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(
      descriptor.bundleId,
      descriptor.runId,
      descriptor.uploaderAccountId,
      descriptor.objectKey,
      digest,
      descriptor.manifestBytes,
      descriptor.objectBytes,
      descriptor.createdAtMs,
      storedAt,
      availableAt,
      descriptor.run.length,
      descriptor.run.sha256,
      screenshot === null ? 0 : 1,
      screenshot?.contentType ?? null,
      screenshot?.length ?? null,
      screenshot?.sha256 ?? null,
    ),
    env.DB.prepare(
      `INSERT INTO ghost_battles (
        uploader_account_id, battle_id, bundle_id, opponent_account_id,
        recorded_at_ms, is_final_battle, projection_json
      )
      SELECT ?1,
             json_extract(value, '$.battle_id'),
             ?2,
             json_extract(value, '$.opponent.account_id'),
             json_extract(value, '$.recorded_at_ms'),
             CASE json_extract(value, '$.is_final_battle') WHEN 1 THEN 1 ELSE 0 END,
             value
      FROM json_each(?3)
      WHERE json_extract(value, '$.opponent.account_id') = ?1
         OR EXISTS (
           SELECT 1 FROM bundle_uploaders
           WHERE player_account_id = json_extract(value, '$.opponent.account_id')
         )
      ON CONFLICT(uploader_account_id, battle_id) DO NOTHING`,
    ).bind(descriptor.uploaderAccountId, descriptor.bundleId, JSON.stringify(descriptor.battles)),
    env.DB.prepare(
      `INSERT INTO bazaardb_deliveries (
        bundle_id, claimable_at_ms, created_at_ms, state_updated_at_ms
      )
      SELECT ?1, ?2, ?2, ?2 WHERE ?3 = 1`,
    ).bind(descriptor.bundleId, availableAt, screenshot === null ? 0 : 1),
    env.DB.prepare(
      `SELECT COUNT(*) AS eligible
       FROM json_each(?1)
       WHERE json_extract(value, '$.opponent.account_id') = ?2
          OR EXISTS (
            SELECT 1 FROM bundle_uploaders
            WHERE player_account_id = json_extract(value, '$.opponent.account_id')
          )`,
    ).bind(JSON.stringify(descriptor.battles), descriptor.uploaderAccountId),
    env.DB.prepare(
      `INSERT INTO bundle_uploaders (player_account_id, first_bundle_at_ms)
       VALUES (?1, ?2) ON CONFLICT(player_account_id) DO NOTHING`,
    ).bind(descriptor.uploaderAccountId, availableAt),
  ];
  const results = await env.DB.batch(statements);
  const eligible = Number(
    (results[3]?.results?.[0] as { eligible?: number } | undefined)?.eligible ?? 0,
  );
  const inserted = Number(results[1]?.meta.changes ?? 0);
  if (inserted < eligible) {
    logEvent("bundle.projection.duplicate", {
      bundle_id: descriptor.bundleId,
      dropped: eligible - inserted,
    });
  }
}

export async function ingestBundle(
  request: Request,
  env: Env,
  requestId: string,
  deps: HandlerDeps,
): Promise<{ status: 200 | 201; receipt: BundleReceipt }> {
  if (request.headers.get("Content-Type") !== "application/x-bpp-bundle-v5") {
    throw new HttpError(415, "unsupported_content_type", "Bundle content type is unsupported", false);
  }
  const contentLength = parseContentLength(request.headers.get("Content-Length"));
  const digest = parseContentDigest(request.headers.get("Content-Digest"));
  if (request.body === null) {
    throw new HttpError(400, "invalid_content_length", "Bundle body is missing", false);
  }
  const opened = await openBundle(request.body, contentLength, digest);
  const { descriptor } = opened;
  const duplicate = await precheck(env, descriptor, digest);
  if (duplicate !== null) {
    await opened.body.cancel("duplicate Bundle").catch(() => undefined);
    return { status: 200, receipt: duplicate };
  }

  const objectWrite = await putConditionally(env, opened, digest);
  const now = deps.now();
  try {
    await commitDescriptor(env, descriptor, digest, now, objectWrite.storedAtMs);
  } catch {
    const bundle = await existingByBundleId(env, descriptor.bundleId).catch(() => null);
    if (bundle !== null) {
      if (bundle.bundle_sha256 === digest) {
        return { status: 200, receipt: duplicateReceipt(bundle) };
      }
      throw new HttpError(409, "bundle_id_conflict", "Bundle ID already has different bytes", false);
    }
    const runBundle = await bundleForRun(env, descriptor.runId).catch(() => null);
    if (runBundle !== null && runBundle !== descriptor.bundleId) {
      if (objectWrite.created) {
        await env.BUNDLE_BUCKET.delete(descriptor.objectKey).catch(() => undefined);
      }
      throw new HttpError(409, "run_already_bundled", "Run already belongs to another Bundle", false);
    }
    logError("bundle.ingest.orphan", {
      request_id: requestId,
      bundle_id: descriptor.bundleId,
      object_key: descriptor.objectKey,
    });
    throw new HttpError(503, "storage_unavailable", "Bundle index commit failed", true);
  }

  logEvent("bundle.ingest", {
    request_id: requestId,
    bundle_id: descriptor.bundleId,
    run_id: descriptor.runId,
    bytes: descriptor.objectBytes,
    has_screenshot: descriptor.screenshot !== null,
    outcome: "stored",
  });
  return {
    status: 201,
    receipt: {
      bundle_id: descriptor.bundleId,
      run_id: descriptor.runId,
      outcome: "stored",
      bazaardb_delivery: descriptor.screenshot === null ? "not_applicable" : "created",
    },
  };
}
