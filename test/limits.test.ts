import { expect, test } from "vitest";

import { MAX_BATTLES_PER_BUNDLE } from "../src/domain/limits";

test("a V5 Bundle accepts at most 30 Battle projections", () => {
  expect(MAX_BATTLES_PER_BUNDLE).toBe(30);
});
