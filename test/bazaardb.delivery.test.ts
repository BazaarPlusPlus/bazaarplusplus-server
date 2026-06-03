import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

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

async function peek(maxItems = 10): Promise<Response> {
  return worker.fetch(
    new Request("https://example.com/bazaardb/peek", {
      method: "POST",
      headers: { ...PullAuth, "content-type": "application/json" },
      body: JSON.stringify({ max_items: maxItems }),
    }),
    env,
  );
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
  await worker.fetch(snapshotUpload("snap-dupe", "{\"first\":true}"), env);
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
  expect(await (await env.BAZAARDB_BUCKET.get(firstRow!.r2_key))!.text()).toBe(
    "{\"first\":true}",
  );
});

test("POST /bazaardb/peek claims oldest pending rows and returns presigned URLs", async () => {
  await seedDelivery("snap-b", "2026-06-03T00:00:02.000Z");
  await seedDelivery("snap-a", "2026-06-03T00:00:01.000Z", { putObject: false });

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
  expect(await second.json()).toEqual({
    status: "peek_outstanding",
    peek_id: firstBody.peek_id,
    lease_expires_at_utc: firstBody.lease_expires_at_utc,
  });
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

test("max-attempt pending rows are failed before claim and removed from R2", async () => {
  const failedKey = await seedDelivery("snap-poison", "2026-06-03T00:00:01.000Z", {
    attempts: 3,
  });
  await seedDelivery("snap-next", "2026-06-03T00:00:02.000Z");

  const response = await peek();

  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<{ snapshot_id: string }> };
  expect(body.items.map((i) => i.snapshot_id)).toEqual(["snap-next"]);
  expect(await env.BAZAARDB_BUCKET.head(failedKey)).toBeNull();

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
});
