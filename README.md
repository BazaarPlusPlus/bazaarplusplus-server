# BazaarPlusPlus Server V5

Cloudflare Worker for the BazaarPlusPlus V5 Bundle pipeline. It receives completed game-run Bundles and makes them discoverable to trusted analyzers, Ghost Battle clients, and BazaarDB. The deployment is fully standalone: its own Worker, D1 database, R2 bucket, migration lineage, and wire contract.

A Bundle is the immutable unit of upload, storage, and delivery — exactly one Run plus at most one optional Screenshot. Three properties shape everything else:

- **Request-driven only.** The Worker exports only `fetch`. There is no cron and no background job: delivery maintenance converges lazily on claim traffic, and D1 retention is an explicit operator action.
- **Streaming, not buffering.** Ingest buffers only the fixed prefix and the bounded manifest; Run and Screenshot bytes stream through incremental digest validation into a single conditional R2 PUT and are never decompressed.
- **No download proxy.** Every consumer downloads the same complete Bundle directly from R2 through a seven-day presigned `GET` URL, inside a 14-day R2 lifecycle window.

The public surface is six routes: liveness, public streaming ingest, token-protected analyzer sync, rate-limited Ghost discovery, and the BazaarDB claim/settle pair. The wire contract is [docs/api-reference.md](docs/api-reference.md); the binary Bundle format and its golden vectors are [contracts/v5](contracts/v5); the domain language is [CONTEXT.md](CONTEXT.md).

## Architecture

The design is a small number of deep seams, recorded in [ADR 0001](docs/adr/0001-v5-deepening-seams.md):

- `src/http/routes.ts` is the complete public route table, and `src/http/route-shell.ts` is the sole HTTP exit — it owns path and method resolution, authentication ordering, CORS, JSON envelopes, and request IDs. Handlers return status and body data, never a `Response`.
- `src/http/deps.ts` is the single dependency channel. Every handler has the form `(request, env, requestId, deps)`, so tests replace the clock and the download signer through one object without touching Worker bindings.
- `src/bundle/open.ts` owns Bundle opening: bounded prefix and manifest reads, manifest validation, and streaming digest validation, all behind one `openBundle` call.
- `src/modules/bundle-commit.ts` owns immutable-identity decisions and the atomic D1 commit, while `src/modules/bundle-ingest.ts` owns R2 orchestration and orphan recovery.

`test/` mirrors the `src/` layout (`http/`, `bundle/`, `modules/`), with golden-vector contract tests under `test/contracts/` and migration, schema, and root-module tests at the top level.

## Development

```sh
npm install
npm run check   # tsc over src and tests, then Biome lint and format verification
npm test        # Vitest in the Workers pool with real local D1 migrations and R2
npm run dev     # wrangler dev; requires .dev.vars (below)
```

`npm run format` rewrites files in place. `npm run dev` needs a git-ignored `.dev.vars` file supplying `R2_PRESIGN_SECRET_ACCESS_KEY`, `BUNDLE_SYNC_TOKEN`, and `BAZAARDB_DELIVERY_TOKEN`; the Worker fails closed without them. Tests inject their own values and need no `.dev.vars`.

## Production

`src/env.ts` is the sole binding declaration. `wrangler.toml` provisions the D1 database, the R2 bucket, the Ghost rate limiter (60 calls per 60 seconds), and the presign vars; the three secrets above are set out of band. The two service tokens are distinct 32-byte random values encoded as 43-character unpadded base64url strings, and the R2 S3 credential grants Object Read only on the V5 bucket.

Provisioning, migration, lifecycle, deploy, and smoke-test commands are in [docs/deployment-runbook.md](docs/deployment-runbook.md) and require explicit Cloudflare deployment authorization. The production D1 database and R2 bucket are provisioned, so schema changes from here on must ship as new migration files — the initial migration is frozen.
