import { expect, test } from "vitest";

import worker from "../src/index";

test("an unknown route returns the canonical not_found error", async () => {
  const response = await worker.fetch(
    new Request("https://mod-api-v5.bazaarplusplus.com/unknown"),
    {} as Cloudflare.Env,
  );

  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");

  const body = await response.json();
  expect(body).toEqual({
    error: {
      code: "not_found",
      message: "Route not found",
      retryable: false,
      request_id: response.headers.get("x-request-id"),
    },
  });
});

test("a known route with the wrong method returns method_not_allowed", async () => {
  const response = await worker.fetch(
    new Request("https://mod-api-v5.bazaarplusplus.com/health", {
      method: "POST",
    }),
    {} as Cloudflare.Env,
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
  expect(await response.json()).toEqual({
    error: {
      code: "method_not_allowed",
      message: "Method not allowed",
      retryable: false,
      request_id: response.headers.get("x-request-id"),
    },
  });
});
