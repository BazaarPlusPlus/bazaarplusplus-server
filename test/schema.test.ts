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
