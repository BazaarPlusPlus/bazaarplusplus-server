import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const RootDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.join(RootDir, "migrations");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      wrangler: {
        configPath: "./wrangler.toml",
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
          R2_ACCOUNT_ID: "test-account-id",
          R2_ACCESS_KEY_ID: "test-access-key-id",
          R2_SECRET_ACCESS_KEY: "test-secret-access-key",
          BAZAARDB_PULL_TOKEN: "test-pull-token",
        },
        isolatedStorage: true,
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
