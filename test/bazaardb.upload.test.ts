import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import { countRows, resetTestState, selectFirst } from "./helpers/seed";

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

beforeEach(async () => {
  await resetTestState(env);
});

function buildUpload(body: unknown): Request {
  return new Request("https://example.com/bazaardb-screenshots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /bazaardb-screenshots returns 400 rejected when player_account_id missing", async () => {
  const response = await worker.fetch(
    buildUpload({
      schema_version: 1,
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      screenshot_id: "ss-001",
      captured_at_utc: "2026-05-26T00:00:00.000Z",
      image_format: "png",
      image_bytes_base64: toBase64(PNG_HEADER),
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    status: "rejected",
    reason: "missing_required_field",
  });
});

test("POST /bazaardb-screenshots stores row + R2 object on valid payload", async () => {
  const response = await worker.fetch(
    buildUpload({
      schema_version: 1,
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      player_account_id: "player-001",
      screenshot_id: "ss-001",
      captured_at_utc: "2026-05-26T00:00:00.000Z",
      image_format: "png",
      image_bytes_base64: toBase64(PNG_HEADER),
      hero_name: "HeroA",
      final_days: 10,
      final_victories: 9,
      player_name: "Player1",
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ status: "ok", screenshot_id: "ss-001" });

  expect(await countRows(env.DB, "bazaardb_screenshots")).toBe(1);
  const row = await selectFirst<{ r2_key: string }>(
    env.DB,
    "SELECT r2_key FROM bazaardb_screenshots WHERE screenshot_id = ?",
    ["ss-001"],
  );
  expect(row?.r2_key).toBe("bazaardb/2026-05-26/ss-001.png");

  const r2 = await env.BAZAARDB_BUCKET.head(row!.r2_key);
  expect(r2).not.toBeNull();
});
