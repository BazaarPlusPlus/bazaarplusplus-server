export interface Env {
  DB: D1Database;
  RUN_BUNDLE_BUCKET: R2Bucket;
  BAZAARDB_BUCKET: R2Bucket;

  RUN_BUNDLE_BUCKET_NAME: string;
  BAZAARDB_BUCKET_NAME: string;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  BAZAARDB_PULL_TOKEN: string;

  // Temporary run-bundle ingest sampling: percent of uploads to keep (0-100).
  // Absent or unparseable keeps every upload.
  RUN_BUNDLE_KEEP_PERCENT?: string;
}
