<div align="center">

# bazaarplusplus-server

**V4 Mod-Facing Backend** for [BazaarPlusPlus](https://bazaarplusplus.com)

[API Reference](docs/api-reference.md) · [BazaarDB Integration](docs/bazaardb-snapshot-integration.md)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?style=flat-square)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org)
[![D1](https://img.shields.io/badge/Storage-D1%20%2B%20R2-f38020?style=flat-square)](https://developers.cloudflare.com/d1/)

</div>

***

Receives run bundles from the BazaarPlusPlus mod, projects them into D1 (runs + battles), serves ghost battle queries and replay presigned URLs, and operates the BazaarDB snapshot pull queue (peek/confirm delivery).

**Production:** `https://mod-api-v4.bazaarplusplus.com`

## Features

- **Run bundle ingest** — multipart upload of gzip MessagePack artifacts with D1 projection (runs, battles) and R2 storage.
- **Ghost battle queries** — 5-day lookback window, ordered by recency, limited to 200 rows.
- **Replay link** — 5-minute SigV4 presigned R2 download URLs for run bundle artifacts.
- **BazaarDB snapshot delivery** — upload queue with peek/confirm semantics, bearer-authed, at-least-once within 3 attempts.
- **Battle ingest filtering** — opponent filtering via `seen_player_accounts` to reduce dead-row writes.

## Quick Start

### Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account with D1 and R2 enabled

### Development

```bash
npm install
npm run dev          # wrangler dev (local)
npm run check        # tsc --noEmit on src + test tsconfigs
npm run test         # vitest with @cloudflare/vitest-pool-workers
```

### Deployment

```bash
wrangler d1 migrations apply DB --remote   # apply pending D1 migrations first
npm run deploy                             # wrangler deploy
```

**Required secrets** (set via `wrangler secret put`):

| Secret                 | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `R2_ACCOUNT_ID`        | R2 account for SigV4 presigning               |
| `R2_ACCESS_KEY_ID`     | R2 API token key id (must cover both buckets) |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret                           |
| `BAZAARDB_PULL_TOKEN`  | Bearer token for BazaarDB peek/confirm        |

## Architecture

```
src/
├── index.ts                 # Route dispatch + CORS + error boundary
├── env.ts                   # Env type (single source of truth for bindings)
├── features/
│   ├── runBundles/          # POST /run-bundles (multipart parse, projection, R2 put)
│   ├── ghostBattles/        # GET /ghost-battles, POST .../replay-link
│   ├── bazaardb/            # POST /bazaardb/snapshots, peek, confirm
│   └── health.ts            # GET /health (liveness only)
├── http/                    # Shared HTTP layer (CORS, JSON, auth, request utils)
├── crypto/                  # SigV4 R2 presigner
└── storage/                 # putThenProject (R2 + D1 two-phase orchestration)
migrations/
├── 0001_v4_initial.sql      # runs, battles, bazaardb_delivery, seen_player_accounts
├── 0002_drop_unused_runs_ended_at_index.sql
├── 0003_add_seen_player_accounts.sql
└── 0004_drop_unused_bazaardb_pending_order_index.sql
docs/
├── api-reference.md         # Wire contract (single source of truth)
├── bazaardb-snapshot-integration.md   # Partner-facing integration guide
├── architecture-decisions.md          # Standing design decisions and rationale
└── known-issues.md                    # Analyzed but unresolved items
```

## API Endpoints

| Method | Path                                    | Auth   | Summary                                 |
| ------ | --------------------------------------- | ------ | --------------------------------------- |
| GET    | `/health`                               | None   | Liveness probe                          |
| POST   | `/run-bundles`                          | None   | Upload run artifact + D1 projections    |
| GET    | `/ghost-battles`                        | None   | Query battles where player was opponent |
| POST   | `/ghost-battles/:battle_id/replay-link` | None   | Presigned download URL for replay       |
| POST   | `/bazaardb/snapshots/:snapshot_id`      | None   | Upload a BazaarDB snapshot DTO          |
| POST   | `/bazaardb/peek`                        | Bearer | Claim next delivery batch               |
| POST   | `/bazaardb/confirm`                     | Bearer | Confirm successful downloads            |

Full contract details: [docs/api-reference.md](docs/api-reference.md)

## Related Repos

| Repo                  | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `bazaarplusplus-mod`  | Game mod (client that uploads to this server)                 |
| `bazaarplusplus-site` | Public site (fetches metrics derived from this server's data) |

## License

Private. All rights reserved.
