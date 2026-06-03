import { expect, test } from "vitest";

import worker from "../src/index";

test("GET /health returns ok", async () => {
  const env = (await import("cloudflare:test")).env;
  const request = new Request("https://example.com/health", { method: "GET" });
  const response = await worker.fetch(request, env);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    status?: string;
    server_time_utc?: string;
  };
  expect(body.status).toBe("ok");
  expect(typeof body.server_time_utc).toBe("string");
  expect(Number.isNaN(Date.parse(body.server_time_utc!))).toBe(false);
});
