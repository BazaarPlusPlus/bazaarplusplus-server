import { beforeEach, expect, test, vi } from "vitest";
import { env } from "cloudflare:test";

import { handleUploadBazaarDbSnapshot } from "../src/features/bazaardb/upload";
import worker from "../src/index";
import { countRows, resetTestState, selectFirst } from "./helpers/seed";

const PullAuth = { Authorization: "Bearer test-pull-token" };

beforeEach(async () => {
  await resetTestState(env);
});

function snapshotUpload(snapshotId: string, body: string, contentType = "application/json"): Request {
  return new Request(`https://example.com/bazaardb/snapshots/${snapshotId}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

async function seedDelivery(
  snapshotId: string,
  uploadedAtUtc: string,
  options: { attempts?: number; r2Key?: string; putObject?: boolean } = {},
): Promise<string> {
  const r2Key =
    options.r2Key ?? `bazaardb/snapshots/${snapshotId}/seeded-upload.json`;
  if (options.putObject ?? true) {
    await env.BAZAARDB_BUCKET.put(r2Key, `{"snapshot":{"id":"${snapshotId}"}}`, {
      httpMetadata: { contentType: "application/json" },
    });
  }
  await env.DB.prepare(
    `
      INSERT INTO bazaardb_delivery (
        snapshot_id, r2_key, content_type, body_bytes, delivery_attempts,
        uploaded_at_utc, state_updated_at_utc
      ) VALUES (?, ?, 'application/json', 32, ?, ?, ?)
    `,
  )
    .bind(snapshotId, r2Key, options.attempts ?? 0, uploadedAtUtc, uploadedAtUtc)
    .run();
  return r2Key;
}

function peekRequest(maxItems?: number): Request {
  return new Request("https://example.com/bazaardb/peek", {
    method: "POST",
    headers: { ...PullAuth, "content-type": "application/json" },
    body: JSON.stringify(maxItems == null ? {} : { max_items: maxItems }),
  });
}

async function peek(maxItems?: number): Promise<Response> {
  return worker.fetch(peekRequest(maxItems), env);
}

async function confirm(peekId: string, snapshotIds: string[]): Promise<Response> {
  return worker.fetch(
    new Request("https://example.com/bazaardb/confirm", {
      method: "POST",
      headers: { ...PullAuth, "content-type": "application/json" },
      body: JSON.stringify({ peek_id: peekId, snapshot_ids: snapshotIds }),
    }),
    env,
  );
}

test("POST /bazaardb/snapshots/:id stores opaque JSON body as a delivery row", async () => {
  const body = JSON.stringify({
    schema_version: 2,
    snapshot: { id: "snap-001", source: "end_of_run_auto" },
    image: { content_type: "image/png", encoding: "base64", data_base64: "AA==" },
  });

  const response = await worker.fetch(snapshotUpload("snap-001", body), env);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", snapshot_id: "snap-001" });
  expect(await countRows(env.DB, "bazaardb_delivery")).toBe(1);

  const row = await selectFirst<{
    r2_key: string;
    content_type: string;
    body_bytes: number;
    delivery_state: string;
  }>(
    env.DB,
    "SELECT r2_key, content_type, body_bytes, delivery_state FROM bazaardb_delivery WHERE snapshot_id = ?",
    ["snap-001"],
  );
  expect(row).not.toBeNull();
  expect(row!.r2_key).toMatch(/^bazaardb\/snapshots\/snap-001\/[A-Za-z0-9._-]+\.json$/);
  expect(row!.content_type).toBe("application/json");
  expect(row!.body_bytes).toBe(new TextEncoder().encode(body).byteLength);
  expect(row!.delivery_state).toBe("pending");

  const stored = await env.BAZAARDB_BUCKET.get(row!.r2_key);
  expect(stored).not.toBeNull();
  expect(await stored!.text()).toBe(body);
  expect(stored!.httpMetadata?.contentType).toBe("application/json");
});

test("snapshot upload guards id, content type, payload size, and old routes", async () => {
  expect((await worker.fetch(snapshotUpload("../bad", "{}"), env)).status).toBe(404);

  const invalidId = await worker.fetch(snapshotUpload("bad%2Fid", "{}"), env);
  expect(invalidId.status).toBe(400);
  expect(await invalidId.json()).toEqual({ error: "invalid_snapshot_id" });

  const dotId = await handleUploadBazaarDbSnapshot(
    snapshotUpload("dot-placeholder", JSON.stringify({ snapshot: { id: "." } })),
    env,
    ".",
  );
  expect(dotId.status).toBe(400);
  expect(await dotId.json()).toEqual({ error: "invalid_snapshot_id" });

  const invalidBody = await worker.fetch(snapshotUpload("snap-body", "{}"), env);
  expect(invalidBody.status).toBe(400);
  expect(await invalidBody.json()).toEqual({ error: "invalid_snapshot_body" });

  const idMismatch = await worker.fetch(
    snapshotUpload("snap-path", JSON.stringify({ snapshot: { id: "snap-body" } })),
    env,
  );
  expect(idMismatch.status).toBe(400);
  expect(await idMismatch.json()).toEqual({ error: "snapshot_id_mismatch" });

  const wrongContentType = await worker.fetch(
    snapshotUpload("snap-content", "{}", "text/plain"),
    env,
  );
  expect(wrongContentType.status).toBe(400);
  expect(await wrongContentType.json()).toEqual({ error: "unsupported_content_type" });

  const tooLarge = await worker.fetch(
    snapshotUpload("snap-large", "x".repeat(4 * 1024 * 1024 + 1)),
    env,
  );
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toEqual({ error: "payload_too_large" });

  const oldUploadRoute = await worker.fetch(
    new Request("https://example.com/bazaardb-screenshots", { method: "POST" }),
    env,
  );
  expect(oldUploadRoute.status).toBe(404);

  const oldManifestRoute = await worker.fetch(
    new Request("https://example.com/bazaardb/manifest", { method: "GET" }),
    env,
  );
  expect(oldManifestRoute.status).toBe(404);
  expect(await countRows(env.DB, "bazaardb_delivery")).toBe(0);
});

test("re-upload of any existing snapshot id is a no-op and does not replace R2", async () => {
  const firstBody = JSON.stringify({ snapshot: { id: "snap-dupe" }, first: true });
  await worker.fetch(snapshotUpload("snap-dupe", firstBody), env);
  const firstRow = await selectFirst<{ r2_key: string }>(
    env.DB,
    "SELECT r2_key FROM bazaardb_delivery WHERE snapshot_id = ?",
    ["snap-dupe"],
  );
  expect(firstRow).not.toBeNull();

  const response = await worker.fetch(snapshotUpload("snap-dupe", "{\"second\":true}"), env);
  expect(response.status).toBe(200);
  const ignoredInvalidReplacement = await worker.fetch(
    snapshotUpload("snap-dupe", "x".repeat(4 * 1024 * 1024 + 1), "text/plain"),
    env,
  );
  expect(ignoredInvalidReplacement.status).toBe(200);

  const rows = await env.DB.prepare(
    "SELECT r2_key, delivery_state FROM bazaardb_delivery WHERE snapshot_id = ?",
  )
    .bind("snap-dupe")
    .all<{ r2_key: string; delivery_state: string }>();
  expect(rows.results).toEqual([
    { r2_key: firstRow!.r2_key, delivery_state: "pending" },
  ]);
  expect((await env.BAZAARDB_BUCKET.list()).objects.map((o) => o.key)).toEqual([
    firstRow!.r2_key,
  ]);
  expect(await (await env.BAZAARDB_BUCKET.get(firstRow!.r2_key))!.text()).toBe(firstBody);
});

test("POST /bazaardb/peek claims oldest pending rows and returns presigned URLs", async () => {
  await seedDelivery("snap-b", "2026-06-03T00:00:02.000Z");
  await seedDelivery("snap-a", "2026-06-03T00:00:01.000Z");

  const response = await peek();

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    peek_id: string;
    lease_expires_at_utc: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(body.peek_id).toMatch(/^pk_[A-Za-z0-9_-]+$/);
  expect(body.items.map((i) => i.snapshot_id)).toEqual(["snap-a", "snap-b"]);
  expect(body.lease_expires_at_utc).toMatch(/Z$/);

  const firstUrl = new URL(body.items[0].download_url);
  expect(firstUrl.hostname).toContain(env.R2_ACCOUNT_ID);
  expect(firstUrl.searchParams.get("X-Amz-Expires")).toBe("600");
  expect(firstUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]+$/);

  const leased = await env.DB.prepare(
    "SELECT snapshot_id, lease_peek_id, delivery_attempts FROM bazaardb_delivery ORDER BY uploaded_at_utc, snapshot_id",
  ).all<{ snapshot_id: string; lease_peek_id: string; delivery_attempts: number }>();
  expect(leased.results).toEqual([
    { snapshot_id: "snap-a", lease_peek_id: body.peek_id, delivery_attempts: 1 },
    { snapshot_id: "snap-b", lease_peek_id: body.peek_id, delivery_attempts: 1 },
  ]);
});

test("peek fails before claim or max-attempt cleanup when R2 presign secrets are missing", async () => {
  const r2Key = await seedDelivery("snap-secret-missing", "2026-06-03T00:00:01.000Z", {
    attempts: 3,
  });
  const badEnv = {
    ...env,
    R2_SECRET_ACCESS_KEY: "",
  };

  // Unexpected failures surface as the canonical envelope with CORS headers.
  const response = await worker.fetch(peekRequest(), badEnv);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "internal_error" });
  expect(response.headers.get("access-control-allow-origin")).toBe("*");

  const row = await selectFirst<{
    delivery_state: string;
    delivery_attempts: number;
    lease_peek_id: string | null;
    lease_until_utc: string | null;
    failure_reason: string | null;
  }>(
    env.DB,
    `
      SELECT delivery_state, delivery_attempts, lease_peek_id, lease_until_utc, failure_reason
      FROM bazaardb_delivery
      WHERE snapshot_id = ?
    `,
    ["snap-secret-missing"],
  );
  expect(row).toEqual({
    delivery_state: "pending",
    delivery_attempts: 3,
    lease_peek_id: null,
    lease_until_utc: null,
    failure_reason: null,
  });
  expect(await env.BAZAARDB_BUCKET.head(r2Key)).not.toBeNull();
});

test("peek returns an empty batch when no rows are pending", async () => {
  const response = await peek();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ peek_id: null, items: [] });
});

test("peek is bearer-gated and returns 409 while a previous lease is outstanding", async () => {
  await seedDelivery("snap-locked", "2026-06-03T00:00:01.000Z");

  const missingAuth = await worker.fetch(
    new Request("https://example.com/bazaardb/peek", { method: "POST" }),
    env,
  );
  expect(missingAuth.status).toBe(401);

  const first = await peek();
  const firstBody = (await first.json()) as {
    peek_id: string;
    lease_expires_at_utc: string;
  };

  const second = await peek();
  expect(second.status).toBe(409);
  const secondBody = (await second.json()) as {
    status: string;
    peek_id: string;
    lease_expires_at_utc: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(secondBody.status).toBe("peek_outstanding");
  expect(secondBody.peek_id).toBe(firstBody.peek_id);
  expect(secondBody.lease_expires_at_utc).toBe(firstBody.lease_expires_at_utc);
  expect(secondBody.items.map((i) => i.snapshot_id)).toEqual(["snap-locked"]);
});

test("confirm marks only requested DTOs done and deletes their R2 objects", async () => {
  const confirmedKey = await seedDelivery("snap-confirmed", "2026-06-03T00:00:01.000Z");
  const unconfirmedKey = await seedDelivery("snap-unconfirmed", "2026-06-03T00:00:02.000Z");
  const peekResponse = await peek();
  const peekBody = (await peekResponse.json()) as { peek_id: string };

  const response = await confirm(peekBody.peek_id, ["snap-confirmed"]);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ confirmed: ["snap-confirmed"], count: 1 });
  expect(await env.BAZAARDB_BUCKET.head(confirmedKey)).toBeNull();
  expect(await env.BAZAARDB_BUCKET.head(unconfirmedKey)).not.toBeNull();

  const rows = await env.DB.prepare(
    "SELECT snapshot_id, delivery_state, lease_peek_id, delivered_at_utc FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{
    snapshot_id: string;
    delivery_state: string;
    lease_peek_id: string | null;
    delivered_at_utc: string | null;
  }>();
  expect(rows.results).toEqual([
    {
      snapshot_id: "snap-confirmed",
      delivery_state: "done",
      lease_peek_id: null,
      delivered_at_utc: expect.stringMatching(/Z$/),
    },
    {
      snapshot_id: "snap-unconfirmed",
      delivery_state: "pending",
      lease_peek_id: peekBody.peek_id,
      delivered_at_utc: null,
    },
  ]);

  const stillLocked = await peek();
  expect(stillLocked.status).toBe(409);
});

test("confirm rejects more snapshot ids than the peek batch maximum", async () => {
  const response = await confirm(
    "pk_overflow",
    Array.from({ length: 51 }, (_, index) => `snap-${index}`),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "too_many_snapshot_ids" });
});

test("explicit max_items claims and confirms batches above 10 while the no-max_items default stays 10", async () => {
  for (let index = 0; index < 12; index += 1) {
    const seconds = String(index).padStart(2, "0");
    await seedDelivery(`snap-bulk-${seconds}`, `2026-06-03T00:00:${seconds}.000Z`);
  }

  const bigPeek = await peek(50);
  expect(bigPeek.status).toBe(200);
  const bigBody = (await bigPeek.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(bigBody.items).toHaveLength(12);

  const confirmed = await confirm(
    bigBody.peek_id,
    bigBody.items.map((item) => item.snapshot_id),
  );
  expect(confirmed.status).toBe(200);
  expect(((await confirmed.json()) as { count: number }).count).toBe(12);

  for (let index = 12; index < 23; index += 1) {
    const seconds = String(index).padStart(2, "0");
    await seedDelivery(`snap-bulk-${seconds}`, `2026-06-03T00:00:${seconds}.000Z`);
  }

  const defaultPeek = await peek();
  expect(defaultPeek.status).toBe(200);
  const defaultBody = (await defaultPeek.json()) as {
    items: Array<{ snapshot_id: string }>;
  };
  expect(defaultBody.items).toHaveLength(10);
});

test("expired leases can be reclaimed with a new peek id", async () => {
  await seedDelivery("snap-retry", "2026-06-03T00:00:01.000Z");
  const first = await peek();
  const firstBody = (await first.json()) as { peek_id: string };
  await env.DB.prepare(
    "UPDATE bazaardb_delivery SET lease_until_utc = '2026-06-03T00:00:00.000Z' WHERE snapshot_id = 'snap-retry'",
  ).run();

  const second = await peek();
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(secondBody.peek_id).not.toBe(firstBody.peek_id);
  expect(secondBody.items).toEqual([{ snapshot_id: "snap-retry", download_url: expect.any(String) }]);

  const row = await selectFirst<{ delivery_attempts: number }>(
    env.DB,
    "SELECT delivery_attempts FROM bazaardb_delivery WHERE snapshot_id = 'snap-retry'",
  );
  expect(row?.delivery_attempts).toBe(2);
});

test("batch-failing at least three rows emits an error-level mass_delivery_failure event", async () => {
  await seedDelivery("snap-burn-a", "2026-06-03T00:00:01.000Z", { attempts: 3 });
  await seedDelivery("snap-burn-b", "2026-06-03T00:00:02.000Z", { attempts: 3 });
  await seedDelivery("snap-burn-c", "2026-06-03T00:00:03.000Z", { attempts: 3 });

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await peek();
    expect(response.status).toBe(200);

    const massFailureEvents = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry.event === "bazaardb.peek");
    expect(massFailureEvents).toEqual([
      expect.objectContaining({
        level: "error",
        failed_count: 3,
        outcome: "mass_delivery_failure",
      }),
    ]);
  } finally {
    errorSpy.mockRestore();
  }

  const failedCount = await selectFirst<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM bazaardb_delivery WHERE delivery_state = 'failed'",
  );
  expect(failedCount?.n).toBe(3);
});

test("409 peek_outstanding re-presigns the leased batch and does not burn an attempt", async () => {
  await seedDelivery("snap-out-a", "2026-06-03T00:00:01.000Z");
  await seedDelivery("snap-out-b", "2026-06-03T00:00:02.000Z");

  const first = await peek();
  const firstBody = (await first.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(firstBody.items.map((i) => i.snapshot_id)).toEqual(["snap-out-a", "snap-out-b"]);

  // Partner "lost" firstBody and re-peeks while the lease is still held.
  const recovery = await peek();
  expect(recovery.status).toBe(409);
  const recoveryBody = (await recovery.json()) as {
    status: string;
    peek_id: string;
    lease_expires_at_utc: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(recoveryBody.status).toBe("peek_outstanding");
  expect(recoveryBody.peek_id).toBe(firstBody.peek_id);
  expect(recoveryBody.items.map((i) => i.snapshot_id)).toEqual(["snap-out-a", "snap-out-b"]);
  expect(recoveryBody.items.every((i) => typeof i.download_url === "string" && i.download_url.length > 0)).toBe(true);

  // Re-fetch must NOT consume a delivery attempt (still 1 from the first peek).
  const attempts = await env.DB.prepare(
    "SELECT delivery_attempts FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{ delivery_attempts: number }>();
  expect(attempts.results.map((r) => r.delivery_attempts)).toEqual([1, 1]);
});

test("peek fails snapshots whose R2 object is gone and excludes them from items", async () => {
  await seedDelivery("snap-gone", "2026-06-03T00:00:01.000Z", { putObject: false });
  await seedDelivery("snap-live", "2026-06-03T00:00:02.000Z");

  const response = await peek();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(body.items.map((i) => i.snapshot_id)).toEqual(["snap-live"]);

  const rows = await env.DB.prepare(
    "SELECT snapshot_id, delivery_state, failure_reason, failed_at_utc, lease_peek_id FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{ snapshot_id: string; delivery_state: string; failure_reason: string | null; failed_at_utc: string | null; lease_peek_id: string | null }>();
  expect(rows.results).toEqual([
    { snapshot_id: "snap-gone", delivery_state: "failed", failure_reason: "object_gone", failed_at_utc: expect.stringMatching(/Z$/), lease_peek_id: null },
    { snapshot_id: "snap-live", delivery_state: "pending", failure_reason: null, failed_at_utc: null, lease_peek_id: body.peek_id },
  ]);
});

test("peek returns an empty batch (peek_id null) when every claimed object is gone", async () => {
  await seedDelivery("snap-allgone-a", "2026-06-03T00:00:01.000Z", { putObject: false });
  await seedDelivery("snap-allgone-b", "2026-06-03T00:00:02.000Z", { putObject: false });

  const response = await peek();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ peek_id: null, items: [] });

  const failed = await selectFirst<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM bazaardb_delivery WHERE delivery_state = 'failed' AND failure_reason = 'object_gone'",
  );
  expect(failed?.n).toBe(2);

  // Lease slot is freed, so a fresh peek is not 409-locked.
  const next = await peek();
  expect(next.status).toBe(200);
  expect(await next.json()).toEqual({ peek_id: null, items: [] });
});

test("409 peek_outstanding head-filters the leased batch and fails an in-lease-deleted object", async () => {
  await seedDelivery("snap-a", "2026-06-03T00:00:01.000Z");
  const snapBKey = await seedDelivery("snap-b", "2026-06-03T00:00:02.000Z");

  const first = await peek();
  const firstBody = (await first.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(firstBody.items.map((i) => i.snapshot_id)).toEqual(["snap-a", "snap-b"]);

  // R2 lifecycle deletes snap-b's object DURING the lease.
  await env.BAZAARDB_BUCKET.delete(snapBKey);

  const recovery = await peek();
  expect(recovery.status).toBe(409);
  const recoveryBody = (await recovery.json()) as {
    status: string;
    peek_id: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(recoveryBody.status).toBe("peek_outstanding");
  expect(recoveryBody.peek_id).toBe(firstBody.peek_id);
  expect(recoveryBody.items.map((i) => i.snapshot_id)).toEqual(["snap-a"]);

  const rows = await env.DB.prepare(
    "SELECT snapshot_id, delivery_state, failure_reason, failed_at_utc, lease_peek_id FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{
    snapshot_id: string;
    delivery_state: string;
    failure_reason: string | null;
    failed_at_utc: string | null;
    lease_peek_id: string | null;
  }>();
  expect(rows.results).toEqual([
    {
      snapshot_id: "snap-a",
      delivery_state: "pending",
      failure_reason: null,
      failed_at_utc: null,
      lease_peek_id: firstBody.peek_id,
    },
    {
      snapshot_id: "snap-b",
      delivery_state: "failed",
      failure_reason: "object_gone",
      failed_at_utc: expect.stringMatching(/Z$/),
      lease_peek_id: null,
    },
  ]);
});

test("mass object_gone in the 409 recovery path raises an error-level mass_delivery_failure", async () => {
  await seedDelivery("snap-mg-a", "2026-06-03T00:00:01.000Z", { putObject: false });
  await seedDelivery("snap-mg-b", "2026-06-03T00:00:02.000Z", { putObject: false });
  await seedDelivery("snap-mg-c", "2026-06-03T00:00:03.000Z", { putObject: false });

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await peek();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ peek_id: null, items: [] });

    const massFailureEvents = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry.event === "bazaardb.peek");
    expect(massFailureEvents).toEqual([
      expect.objectContaining({
        level: "error",
        outcome: "mass_delivery_failure",
        failure_reason: "object_gone",
        gone_count: 3,
      }),
    ]);
  } finally {
    errorSpy.mockRestore();
  }

  const failed = await selectFirst<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM bazaardb_delivery WHERE delivery_state = 'failed' AND failure_reason = 'object_gone'",
  );
  expect(failed?.n).toBe(3);
});

test("max-attempt pending rows fail terminally and leave their R2 objects for lifecycle cleanup", async () => {
  const failedKey = await seedDelivery("snap-poison", "2026-06-03T00:00:01.000Z", {
    attempts: 3,
  });
  await seedDelivery("snap-next", "2026-06-03T00:00:02.000Z");

  const response = await peek();

  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<{ snapshot_id: string }> };
  expect(body.items.map((i) => i.snapshot_id)).toEqual(["snap-next"]);
  expect(await env.BAZAARDB_BUCKET.head(failedKey)).not.toBeNull();

  const failed = await selectFirst<{
    delivery_state: string;
    failed_at_utc: string | null;
    failure_reason: string | null;
  }>(
    env.DB,
    "SELECT delivery_state, failed_at_utc, failure_reason FROM bazaardb_delivery WHERE snapshot_id = 'snap-poison'",
  );
  expect(failed).toMatchObject({
    delivery_state: "failed",
    failed_at_utc: expect.stringMatching(/Z$/),
    failure_reason: "max_delivery_attempts",
  });

  // Re-uploading a failed snapshot id stays a no-op: 200, no revival to pending.
  const reupload = await worker.fetch(
    snapshotUpload("snap-poison", JSON.stringify({ snapshot: { id: "snap-poison" } })),
    env,
  );
  expect(reupload.status).toBe(200);
  const afterReupload = await selectFirst<{ delivery_state: string }>(
    env.DB,
    "SELECT delivery_state FROM bazaardb_delivery WHERE snapshot_id = 'snap-poison'",
  );
  expect(afterReupload).toEqual({ delivery_state: "failed" });
});
