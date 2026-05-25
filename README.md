# bazaarplusplus-server

V4 mod-facing backend for BazaarPlusPlus. Serves run-bundle ingest, ghost-battle queries, replay links, and BazaarDB screenshot ingest + daily manifest.

Production: `https://mod-api-v4.bazaarplusplus.com`

## Commands

```bash
npm run check        # tsc on src + test configs
npm run test         # vitest with @cloudflare/vitest-pool-workers
npm run dev          # wrangler dev
npm run deploy       # wrangler deploy
```

## Architecture

See [docs/specs/2026-05-25-v4-server-split-design.md](../docs/specs/2026-05-25-v4-server-split-design.md) and the wire contract at [docs/api-reference.md](docs/api-reference.md).
