import { expect, test } from "vitest";

import worker from "../src/index";

test("GET /health returns ok", async () => {
  const env = (await import("cloudflare:test")).env;
  const request = new Request("https://example.com/health", { method: "GET" });
  const response = await worker.fetch(request, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
