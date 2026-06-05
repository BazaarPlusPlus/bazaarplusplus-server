import { expect, test } from "vitest";

import wranglerContents from "../wrangler.toml?raw";

type WranglerConfigSubset = {
  vars: Record<string, string>;
  r2Buckets: Array<{ binding?: string; bucket_name?: string }>;
};

function parseWranglerConfigSubset(contents: string): WranglerConfigSubset {
  const vars: Record<string, string> = {};
  const r2Buckets: Array<{ binding?: string; bucket_name?: string }> = [];
  let section: "vars" | "r2_buckets" | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line === "[vars]") {
      section = "vars";
      continue;
    }
    if (line === "[[r2_buckets]]") {
      section = "r2_buckets";
      r2Buckets.push({});
      continue;
    }

    const assignment = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (assignment == null || section == null) {
      continue;
    }

    const [, key, value] = assignment;
    if (section === "vars") {
      vars[key] = value;
    } else {
      r2Buckets[r2Buckets.length - 1][key as "binding" | "bucket_name"] = value;
    }
  }

  return { vars, r2Buckets };
}

test("presign bucket name vars match their R2 bucket bindings", () => {
  const config = parseWranglerConfigSubset(wranglerContents);
  const bucketNameByBinding = Object.fromEntries(
    config.r2Buckets.map((bucket) => [bucket.binding, bucket.bucket_name]),
  );

  expect(config.vars.RUN_BUNDLE_BUCKET_NAME).toBe(
    bucketNameByBinding.RUN_BUNDLE_BUCKET,
  );
  expect(config.vars.BAZAARDB_BUCKET_NAME).toBe(
    bucketNameByBinding.BAZAARDB_BUCKET,
  );
});
