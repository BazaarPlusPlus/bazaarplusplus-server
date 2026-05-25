import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import { resetTestState } from "./helpers/seed";

beforeEach(async () => {
  await resetTestState(env);
});

async function seedScreenshot(
  id: string,
  date: string,
  uploadedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bazaardb_screenshots (
      screenshot_id, player_account_id, captured_at_utc, captured_date_utc,
      image_format, image_sha256, image_bytes, r2_key, uploaded_at_utc, schema_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, "player-1", `${date}T12:00:00.000Z`, date,
    "png", "deadbeef", 100, `bazaardb/${date}/${id}.png`, uploadedAt, 1,
  ).run();
}

test("GET /bazaardb/manifest returns 401 when bearer missing", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/bazaardb/manifest?date=2026-05-26", { method: "GET" }),
    env,
  );
  expect(response.status).toBe(401);
});

test("GET /bazaardb/manifest returns 400 invalid_date for malformed date", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/bazaardb/manifest?date=not-a-date", {
      method: "GET",
      headers: { Authorization: "Bearer test-pull-token" },
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_date" });
});

test("GET /bazaardb/manifest returns rows ordered by (uploaded_at_utc, screenshot_id) with public image_url", async () => {
  await seedScreenshot("ss-a", "2026-05-26", "2026-05-26T00:00:01.000Z");
  await seedScreenshot("ss-b", "2026-05-26", "2026-05-26T00:00:02.000Z");
  await seedScreenshot("ss-c", "2026-05-27", "2026-05-27T00:00:00.000Z");

  const response = await worker.fetch(
    new Request("https://example.com/bazaardb/manifest?date=2026-05-26", {
      method: "GET",
      headers: { Authorization: "Bearer test-pull-token" },
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    rows: Array<{ screenshot_id: string; image_url: string }>;
    next_cursor: string | null;
  };
  expect(body.rows.map((r) => r.screenshot_id)).toEqual(["ss-a", "ss-b"]);
  expect(body.rows[0].image_url).toBe(
    "https://bazaardb-assets-v4.bazaarplusplus.com/bazaardb/2026-05-26/ss-a.png",
  );
  expect(body.next_cursor).toBeNull();
});

test("GET /bazaardb/manifest pagination: cursor returns subsequent page", async () => {
  for (let i = 0; i < 5; i++) {
    await seedScreenshot(
      `ss-${i}`,
      "2026-05-26",
      `2026-05-26T00:00:0${i}.000Z`,
    );
  }

  const first = await worker.fetch(
    new Request("https://example.com/bazaardb/manifest?date=2026-05-26&limit=2", {
      method: "GET",
      headers: { Authorization: "Bearer test-pull-token" },
    }),
    env,
  );
  const firstBody = (await first.json()) as {
    rows: Array<{ screenshot_id: string }>;
    next_cursor: string | null;
  };
  expect(firstBody.rows.map((r) => r.screenshot_id)).toEqual(["ss-0", "ss-1"]);
  expect(firstBody.next_cursor).not.toBeNull();

  const second = await worker.fetch(
    new Request(
      `https://example.com/bazaardb/manifest?date=2026-05-26&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      {
        method: "GET",
        headers: { Authorization: "Bearer test-pull-token" },
      },
    ),
    env,
  );
  const secondBody = (await second.json()) as {
    rows: Array<{ screenshot_id: string }>;
  };
  expect(secondBody.rows.map((r) => r.screenshot_id)).toEqual(["ss-2", "ss-3"]);
});
