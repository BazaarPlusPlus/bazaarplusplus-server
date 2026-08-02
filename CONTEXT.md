# BPP V5 Data Pipeline

This Worker receives completed game-run Bundles and makes them discoverable by trusted analyzers, Ghost Battle clients, and BazaarDB.

## Language

**Bundle**: The smallest immutable upload, storage, and delivery unit. It contains exactly one Run and, when available, one optional Screenshot.

**Run**: Immutable facts, battles, card state, and replay data for one completed game run. It excludes the Screenshot.

**Screenshot**: The optional end-of-run image stored inside the Bundle. Its absence never invalidates the Bundle.

**BazaarDB Delivery**: A claimable obligation to deliver one Screenshot-bearing Bundle to BazaarDB. Settling a delivery does not delete the Bundle.

**Ghost Battle**: A directional query projection derived from a Bundle manifest. It is not authoritative Battle data.

## Runtime boundaries

The Worker exposes liveness, Bundle ingest, stateless Bundle collection, Ghost discovery, and BazaarDB claim/settle. It exports only `fetch`, has no cron or scheduled handler, and performs no automatic D1 cleanup. Bundle upload retries recover matching R2-only objects, while claim requests lazily converge expired deliveries and exhausted attempts; settle only guards lease ownership. D1 retention is maintained manually by operators.

Bundle ingest buffers only the fixed prefix and bounded manifest. Run and Screenshot bytes remain compressed/encoded and flow through incremental digest validation into one conditional R2 PUT. The D1 Bundle row, eligible Ghost projections, optional BazaarDB delivery, and uploader record commit in one batch.

All consumers download the same complete Bundle directly from a seven-day R2 presigned `GET` URL. The Worker has no download proxy. R2 retention is 14 days. Ghost queries expose only the most recent five days, Bundle collection accepts only the 14-day R2 window, and older D1 rows remain until manual maintenance.

`bundle_uploaders` is monotonic for the V5 deployment. It records successful uploader assertions, not authenticated identities. A projection is eligible only for self or an opponent already present before that Bundle's final uploader insert; rejected history is never backfilled.

Avoid the V4 and abandoned names: Boundle, Pack, Run artifact, Run Bundle, Snapshot, and Screenshot upload.
