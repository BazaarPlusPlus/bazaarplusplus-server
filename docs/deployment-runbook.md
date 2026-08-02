# BazaarPlusPlus Server V5 deployment runbook

These commands create or mutate Cloudflare resources. Run them only with production deployment authorization, from the repository root, using an authenticated Wrangler profile for the intended account.

## 1. Validate the local artifact

```sh
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
git diff --check
```

## 2. Create isolated storage

```sh
npx wrangler d1 create bazaarplusplus-mod-api-v5-db --location apac
npx wrangler r2 bucket create bazaarplusplus-bundle-v5 --location apac
```

Put the returned D1 UUID in `wrangler.toml` as `database_id`. Replace `R2_ACCOUNT_ID` with the Cloudflare account ID.

Create an R2 S3 API credential scoped to `bazaarplusplus-bundle-v5` with Object Read permission only. Put its Access Key ID in `R2_PRESIGN_ACCESS_KEY_ID`. Do not grant write, delete, or access to another bucket.

Set the bucket lifecycle:

```sh
npx wrangler r2 bucket lifecycle add bazaarplusplus-bundle-v5 v5-bundle-retention bundles/ --expire-days 14
npx wrangler r2 bucket lifecycle list bazaarplusplus-bundle-v5
```

The listing must show the `bundles/` prefix expiring after 14 days.

## 3. Configure rate limiting and secrets

Set `namespace_id` in `wrangler.toml` to a positive integer unique to this Cloudflare account. Keep the configured threshold at 60 calls per 60 seconds.

Generate two independent service tokens:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Each output must be 43 characters, and the values must differ.

Write the secrets without putting them in shell history or repository files:

```sh
npx wrangler secret put R2_PRESIGN_SECRET_ACCESS_KEY
npx wrangler secret put BUNDLE_SYNC_TOKEN
npx wrangler secret put BAZAARDB_DELIVERY_TOKEN
```

## 4. Apply migrations and deploy

```sh
npx wrangler d1 migrations apply bazaarplusplus-mod-api-v5-db --remote
npx wrangler deploy
```

Verify the custom domain resolves only to `bazaarplusplus-mod-api-v5` and that the Worker has no cron trigger.

## 5. Production smoke test

Use a generated Bundle from the checked-in V5 contract implementation, not a production player's data.

1. `GET /health` returns `200`, a request ID, and a safe-integer server time.
2. Upload a Run-only Bundle with `POST /bundles`; expect `201 stored` and `not_applicable`.
3. Repeat identical bytes; expect `200 duplicate`.
4. Upload a Screenshot-bearing Bundle; expect `201 stored` and `created`.
5. After the 60-second settle lag, list both with the Bundle Sync token. Confirm keyset ordering and `X-Amz-Expires=604800`.
6. Download one URL twice with `GET`; both responses must equal the uploaded bytes.
7. Change the URL object key, use `HEAD`, change `X-Amz-Expires`, and change one signature character. R2 must reject every modified request.
8. Query a seeded eligible Ghost account. Confirm the five-day projection and direct R2 Bundle download.
9. Exceed the Ghost limit from a controlled test address. Confirm `429`, `Retry-After: 60`, and no D1/presign activity in route logs.
10. Claim the Screenshot-bearing Bundle with the BazaarDB token, download it once, and settle `accepted`. Repeating the settle must return `duplicate`.
11. Repeat with injected retryable failures to verify the 60-second and five-minute backoffs and third-attempt exhaustion.
12. Inject a D1 commit failure after a valid R2 PUT, then repeat the original `POST /bundles` and confirm the idempotent retry commits the R2-only object while preserving its R2 upload time.
13. Confirm logs contain no service token, R2 secret, Bundle body, projection JSON, Screenshot bytes, or complete presigned URL.

## 6. Post-deploy checks

### 6.1 Log-based alerts (Workers Observability)

The Worker emits one structured JSON line per alertable condition, so each alert is a
Workers Observability query on the `bazaarplusplus-mod-api-v5` Worker (dashboard:
Compute → Workers → Observability → create a query, then attach an alert with a
notification destination). Suggested starting thresholds; tune against real traffic.

| Alert | Query filter | Suggested threshold |
| --- | --- | --- |
| Server 5xx (storage, presign, unclassified) | `event = "worker.http_error" OR event = "worker.internal_error"` | > 5 in 5 min |
| Presign / storage failure specifically | `event = "worker.http_error" AND code = "storage_unavailable"` | > 5 in 5 min |
| Service token misconfiguration | `event = "worker.http_error" AND code = "invalid_configuration"` | ≥ 1 in 5 min |
| Ingest identity conflicts | invocation logs: request path `/bundles`, method POST, response status 409 | > 10 in 15 min |
| Ghost 429 rate | `event = "ghost.discovery" AND limited = true` | > 100 in 5 min |
| Ingest orphan objects | `event = "bundle.ingest.orphan" OR event = "bundle.orphan.invalid"` | ≥ 1 in 15 min |

Classified 4xx responses are intentionally not logged; they are client errors and
would drown the signal.

### 6.2 D1 state checks (external prober)

Aged pending deliveries, exhausted attempts, database size, and the age of manually
retained rows are D1 state, not log events, and the Worker deliberately has no cron.
Run these from an external scheduler (CI cron or an operator shell) with a Cloudflare
API token scoped to D1 read:

```sh
npx wrangler d1 execute bazaarplusplus-mod-api-v5-db --remote --json --command "SELECT COUNT(*) AS aged_pending FROM bazaardb_deliveries WHERE delivery_state = 'pending' AND created_at_ms < (unixepoch() - 86400) * 1000"
```

```sh
npx wrangler d1 execute bazaarplusplus-mod-api-v5-db --remote --json --command "SELECT COUNT(*) AS exhausted FROM bazaardb_deliveries WHERE delivery_state = 'failed' AND failure_reason = 'delivery_attempts_exhausted' AND failed_at_ms > (unixepoch() - 86400) * 1000"
```

```sh
npx wrangler d1 execute bazaarplusplus-mod-api-v5-db --remote --json --command "SELECT COUNT(*) AS total_bundles, MIN(stored_at_ms) AS oldest_stored_at_ms FROM bundles"
```

Alert when `aged_pending` is nonzero for more than a day (BazaarDB has stopped
claiming or keeps failing), when `exhausted` jumps, or when `oldest_stored_at_ms`
ages past the agreed manual-retention horizon.

### 6.3 Ecosystem gates

- Verify the analyzer and BazaarDB clients compare the decoded Run identity/version with the Bundle manifest and quarantine mismatches.
- Do not release the V5 mod until analyzer and BazaarDB consumers have completed the direct-R2 smoke test.

## 7. Manual D1 maintenance boundary

The Worker has no automatic D1 TTL. Operators choose retention cutoffs, inspect the candidate row counts, and run separately authorized D1 cleanup outside deployment. Deleting a `bundles` row cascades to its Ghost projections, BazaarDB delivery, and attempt receipts; `bundle_uploaders` is deployment-lifetime state and is not part of routine cleanup.
