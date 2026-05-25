import type { Env } from "../../env";
import { requireBearer } from "../../http/auth";
import { json, jsonError } from "../../http/json";
import { parseClampedInteger } from "../../http/request";
import { logInfo } from "../../observability";

const DatePattern = /^\d{4}-\d{2}-\d{2}$/;
const PublicAssetHost = "bazaardb-assets-v4.bazaarplusplus.com";

type ManifestRow = {
  screenshot_id: string;
  player_account_id: string;
  run_id: string | null;
  hero_name: string | null;
  final_days: number | null;
  final_victories: number | null;
  player_name: string | null;
  player_rank: string | null;
  player_rating: number | null;
  player_position: number | null;
  captured_at_utc: string;
  image_format: string;
  image_sha256: string;
  image_bytes: number;
  r2_key: string;
  uploaded_at_utc: string;
};

function decodeCursor(
  value: string | null,
): { uploadedAt: string; screenshotId: string } | null {
  if (!value) return { uploadedAt: "", screenshotId: "" };
  try {
    const decoded = atob(value);
    const colon = decoded.lastIndexOf(":");
    if (colon < 0) return null;
    return {
      uploadedAt: decoded.slice(0, colon),
      screenshotId: decoded.slice(colon + 1),
    };
  } catch {
    return null;
  }
}

function encodeCursor(uploadedAt: string, screenshotId: string): string {
  return btoa(`${uploadedAt}:${screenshotId}`);
}

function validDate(value: string | null): string | null {
  if (value == null || !DatePattern.test(value)) return null;
  const ts = new Date(`${value}T00:00:00Z`).getTime();
  if (Number.isNaN(ts)) return null;
  return value;
}

export async function handleGetBazaarDbManifest(
  request: Request,
  env: Env,
): Promise<Response> {
  const phaseStart = Date.now();

  const unauthorized = requireBearer(request, env, "BAZAARDB_PULL_TOKEN");
  if (unauthorized != null) return unauthorized;

  const url = new URL(request.url);
  const date = validDate(url.searchParams.get("date"));
  if (date == null) return jsonError("invalid_date");

  const limit = parseClampedInteger(url.searchParams.get("limit"), 200, 1, 500);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (cursor == null) return jsonError("invalid_cursor");

  const d1Start = Date.now();
  const result = await env.DB.prepare(
    `
      SELECT screenshot_id, player_account_id, run_id, hero_name, final_days,
             final_victories, player_name, player_rank, player_rating, player_position,
             captured_at_utc, image_format, image_sha256, image_bytes, r2_key, uploaded_at_utc
      FROM bazaardb_screenshots
      WHERE captured_date_utc = ?
        AND (uploaded_at_utc > ?
             OR (uploaded_at_utc = ? AND screenshot_id > ?))
      ORDER BY uploaded_at_utc, screenshot_id
      LIMIT ?
    `,
  )
    .bind(date, cursor.uploadedAt, cursor.uploadedAt, cursor.screenshotId, limit)
    .all<ManifestRow>();
  const d1ReadMs = Date.now() - d1Start;

  const rows = result.results.map((row) => ({
    screenshot_id: row.screenshot_id,
    player_account_id: row.player_account_id,
    run_id: row.run_id,
    hero_name: row.hero_name,
    final_days: row.final_days,
    final_victories: row.final_victories,
    player_name: row.player_name,
    player_rank: row.player_rank,
    player_rating: row.player_rating,
    player_position: row.player_position,
    captured_at_utc: row.captured_at_utc,
    image_format: row.image_format,
    image_sha256: row.image_sha256,
    image_bytes: row.image_bytes,
    image_url: `https://${PublicAssetHost}/${encodeURI(row.r2_key)}`,
  }));

  const nextCursor =
    rows.length === limit
      ? encodeCursor(
          result.results[result.results.length - 1].uploaded_at_utc,
          result.results[result.results.length - 1].screenshot_id,
        )
      : null;

  logInfo("bazaardb.manifest", {
    phase_ms: { d1_read: d1ReadMs, total: Date.now() - phaseStart },
    row_count: rows.length,
    page_size: limit,
  });

  return json({ rows, next_cursor: nextCursor });
}
