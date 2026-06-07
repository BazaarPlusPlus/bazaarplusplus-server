import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("runs keeps the analyzer mirror index and drops the unused ended_at index", async () => {
  const indexes = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' ORDER BY name",
  ).all<{ name: string }>();
  const indexNames = indexes.results.map((row) => row.name);

  expect(indexNames).toContain("idx_runs_updated_at");
  expect(indexNames).not.toContain("idx_runs_ended_at");
});

test("seen_player_accounts exists with player_account_id as the only key", async () => {
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seen_player_accounts'",
  ).first<{ name: string }>();
  expect(table).toEqual({ name: "seen_player_accounts" });

  const columns = await env.DB.prepare(
    "PRAGMA table_info(seen_player_accounts)",
  ).all<{ name: string; type: string; notnull: number; pk: number }>();
  expect(columns.results.map((column) => ({
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    pk: column.pk,
  }))).toEqual([
    { name: "player_account_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "first_seen_at_utc", type: "TEXT", notnull: 1, pk: 0 },
  ]);

  const indexes = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'seen_player_accounts' ORDER BY name",
  ).all<{ name: string }>();
  expect(indexes.results.map((row) => row.name)).toEqual(["sqlite_autoindex_seen_player_accounts_1"]);
});

test("seen_player_accounts backfill seeds historical uploaders only", async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM battles"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM seen_player_accounts"),
  ]);

  const insertRun = env.DB.prepare(
    `
      INSERT INTO runs (
        run_id, player_account_id, payload_hash, schema_version, object_key, codec,
        size_bytes, status, ended_at_utc, submitted_at_utc, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, 5, ?, 'application/x-bpp-runbundle+msgpack+gzip',
        4, 'completed', ?, ?, ?, ?)
    `,
  );
  await env.DB.batch([
    insertRun.bind(
      "run-a-late",
      "uploader-a",
      "hash-a-late",
      "run-bundles/a-late.mpack.gz",
      "2026-05-26T02:00:00.000Z",
      "2026-05-26T02:00:00.000Z",
      "2026-05-26T02:00:00.000Z",
      "2026-05-26T02:00:00.000Z",
    ),
    insertRun.bind(
      "run-a-early",
      "uploader-a",
      "hash-a-early",
      "run-bundles/a-early.mpack.gz",
      "2026-05-26T01:00:00.000Z",
      "2026-05-26T01:00:00.000Z",
      "2026-05-26T01:00:00.000Z",
      "2026-05-26T01:00:00.000Z",
    ),
    insertRun.bind(
      "run-b",
      "uploader-b",
      "hash-b",
      "run-bundles/b.mpack.gz",
      "2026-05-26T03:00:00.000Z",
      "2026-05-26T03:00:00.000Z",
      "2026-05-26T03:00:00.000Z",
      "2026-05-26T03:00:00.000Z",
    ),
  ]);

  await env.DB.prepare(
    `
      INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc)
      SELECT player_account_id, MIN(created_at_utc)
      FROM runs
      GROUP BY player_account_id
    `,
  ).run();

  const rows = await env.DB.prepare(
    "SELECT player_account_id, first_seen_at_utc FROM seen_player_accounts ORDER BY player_account_id",
  ).all<{ player_account_id: string; first_seen_at_utc: string }>();
  expect(rows.results).toEqual([
    { player_account_id: "uploader-a", first_seen_at_utc: "2026-05-26T01:00:00.000Z" },
    { player_account_id: "uploader-b", first_seen_at_utc: "2026-05-26T03:00:00.000Z" },
  ]);
});
