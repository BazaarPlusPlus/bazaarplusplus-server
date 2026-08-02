# Project Rules

- This branch is the standalone V5 mod-facing backend. Do not copy V4 handlers, migrations, bindings, object layouts, or wire behavior unless a V5 design document explicitly requires it.
- `src/env.ts` is the only place to declare Worker bindings, vars, and secrets.
- A Bundle is the smallest upload, R2 storage, and delivery unit. It contains exactly one Run and zero or one Screenshot.
- `MAX_BATTLES_PER_BUNDLE` is 30.
- Bundle upload is intentionally unauthenticated. `uploader_account_id` and `bundle_uploaders` are caller assertions, never authentication or authorization facts.
- `bundle_uploaders` starts empty, records only successful V5 Bundle uploaders, and is updated as the final Bundle commit statement with `ON CONFLICT DO NOTHING`.
- Ghost projection accepts only a self opponent or an opponent already in `bundle_uploaders`. Filtered history is never backfilled.
- Duplicate `battle_id` values inside one Bundle are invalid. A repeated `(uploader_account_id, battle_id)` across Bundles is anomalous: preserve the first projection and record a metric; never merge fields across Bundles.
- The Worker never exposes a Bundle download proxy and never decompresses the Run payload during ingest.
- Tests exercise public module interfaces. Storage adapter tests may inspect schema and query plans when the migration or SQL statement is the interface under test.

# Pull Request Hygiene

- Use a clear, correctly capitalized, imperative PR title with no conventional-commit prefix and no trailing punctuation.
- End the PR body with `Release Notes:` and one `Added`/`Fixed`/`Improved` bullet, or `N/A` for backend-internal work.
