import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";

import worker from "../src/index";
import { makeBundleFixture, uploadRequest } from "./fixtures/bundle";

afterEach(() => {
  vi.restoreAllMocks();
});

test("structured logs omit caller identities, secrets, bodies and presigned URLs", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const account = "sensitive-account-must-not-be-logged";
  const fixture = await makeBundleFixture({
    bundleId: "01J00000000000000000000811",
    runId: "observability-run",
    uploaderAccountId: account,
    opponentAccountId: account,
  });
  expect((await worker.fetch(uploadRequest(fixture.body, fixture.headers), env)).status).toBe(201);
  expect(
    (
      await worker.fetch(
        new Request(
          `https://mod-api-v5.bazaarplusplus.com/ghost-battles?player_account_id=${account}`,
        ),
        env,
      )
    ).status,
  ).toBe(200);

  const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
  expect(output).not.toContain(account);
  expect(output).not.toContain(env.BUNDLE_SYNC_TOKEN);
  expect(output).not.toContain(env.BAZAARDB_DELIVERY_TOKEN);
  expect(output).not.toContain(env.R2_PRESIGN_SECRET_ACCESS_KEY);
  expect(output).not.toContain("X-Amz-");
});
