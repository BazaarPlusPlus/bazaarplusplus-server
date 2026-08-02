# BazaarPlusPlus Server V5

Standalone Cloudflare Worker for the BazaarPlusPlus V5 Bundle pipeline. It uses an independent Worker, D1 database, R2 bucket, migration lineage, and wire contract.

One immutable Bundle contains exactly one Run and zero or one Screenshot. The Worker never decompresses Run payloads and never proxies Bundle downloads.

## Interfaces

- `GET /health`: liveness;
- `POST /bundles`: public streaming Bundle ingest;
- `GET /bundles`: token-protected analyzer time-window sync;
- `GET /ghost-battles`: public five-day Ghost discovery with per-IP rate limiting;
- `POST /bazaardb/deliveries/claim`: token-protected ten-minute delivery leases;
- `POST /bazaardb/deliveries/settle`: idempotent per-attempt delivery settlement.

Discovery returns seven-day R2 SigV4 `GetObject` URLs. R2 lifecycle retention is 14 days. An R2-only object left by a failed D1 commit is recovered only by an idempotent client upload retry; otherwise the bucket lifecycle expires it. The Worker exports no scheduled handler and performs no automatic D1 cleanup; D1 maintenance is an operator action. The complete interface is documented in [docs/api-reference.md](docs/api-reference.md), and the Bundle contract and golden vectors are in [contracts/v5](contracts/v5).

## Local development

```sh
npm install
npm run check
npm test
npm run dev
```

Tests run in the Cloudflare Workers Vitest pool with real local D1 migrations and R2 bindings. `npm run check` type-checks production and test code.

## Code layout

`src/http/routes.ts` is the route table, and `src/http/route-shell.ts` is the sole HTTP exit.
`src/bundle/open.ts` owns Bundle opening and streaming validation.
`src/modules/bundle-commit.ts` owns Bundle persistence decisions and the atomic D1 commit.

## Production configuration

`src/env.ts` is the sole binding declaration. Wrangler provides:

- `DB`: `bazaarplusplus-mod-api-v5-db`;
- `BUNDLE_BUCKET`: `bazaarplusplus-bundle-v5`;
- `GHOST_BATTLE_RATE_LIMITER`: 60 calls per 60 seconds;
- `BUNDLE_BUCKET_NAME`, `R2_ACCOUNT_ID`, and `R2_PRESIGN_ACCESS_KEY_ID` vars;
- `R2_PRESIGN_SECRET_ACCESS_KEY`, `BUNDLE_SYNC_TOKEN`, and `BAZAARDB_DELIVERY_TOKEN` secrets.

The two service tokens are distinct 32-byte random values encoded as 43-character unpadded base64url strings. The R2 S3 credential grants Object Read only on the V5 bucket.

The checked-in D1 database ID and presign values are placeholders. Provisioning, migration, lifecycle, deploy, and smoke-test commands are in [docs/deployment-runbook.md](docs/deployment-runbook.md). They require explicit Cloudflare deployment authorization.
