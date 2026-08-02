# BazaarPlusPlus Server V5

Standalone Cloudflare Worker for the BPP V5 Bundle pipeline.

V5 uses a fresh Worker, D1 database, R2 bucket, migrations, and wire contract. The V4 implementation remains on the repository's `master` worktree for reference and production drain; V5 does not import V4 source code.

## Local development

```sh
npm install
npm run check
npm test
npm run dev
```

The checked-in D1 database ID and R2 presign configuration are non-production placeholders. Create the V5 Cloudflare resources and configure secrets before deployment.

## Current implementation

- independent V5 package and Wrangler configuration;
- liveness route and canonical JSON errors;
- initial V5 D1 schema and maintenance indexes;
- `MAX_BATTLES_PER_BUNDLE = 30`.

Bundle ingest, collection, Ghost Battle discovery, R2 presigning, BazaarDB delivery, and maintenance handlers are intentionally not implemented in this foundation slice.
