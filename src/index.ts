import type { Env } from "./env";
import { handleConfirmBazaarDbSnapshots } from "./features/bazaardb/confirm";
import { handlePeekBazaarDbSnapshots } from "./features/bazaardb/peek";
import { handleUploadBazaarDbSnapshot } from "./features/bazaardb/upload";
import { handleQueryGhostBattles } from "./features/ghostBattles/query";
import { handleCreateReplayLink } from "./features/ghostBattles/replayLink";
import { handleHealth } from "./features/health";
import { handleCreateRunBundleDownloadLink } from "./features/runBundles/downloadLink";
import { handleUploadRunBundle } from "./features/runBundles/upload";
import { preflight, withCors } from "./http/cors";
import { jsonError } from "./http/json";
import { logError } from "./observability";

type StaticRoute = {
  method: string;
  pattern: RegExp;
  paramNames?: string[];
  decodeErrorCode?: string;
  handle: (
    request: Request,
    env: Env,
    params: Record<string, string>,
  ) => Promise<Response> | Response;
};

const Routes: StaticRoute[] = [
  { method: "GET", pattern: /^\/health$/, handle: () => handleHealth() },
  { method: "POST", pattern: /^\/run-bundles$/, handle: handleUploadRunBundle },
  {
    method: "POST",
    pattern: /^\/run-bundles\/([^/]+)\/download-link$/,
    paramNames: ["run_id"],
    decodeErrorCode: "bad_request",
    handle: (request, env, params) =>
      handleCreateRunBundleDownloadLink(request, env, params.run_id),
  },
  { method: "GET", pattern: /^\/ghost-battles$/, handle: handleQueryGhostBattles },
  { method: "POST", pattern: /^\/bazaardb\/peek$/, handle: handlePeekBazaarDbSnapshots },
  { method: "POST", pattern: /^\/bazaardb\/confirm$/, handle: handleConfirmBazaarDbSnapshots },
  {
    method: "POST",
    pattern: /^\/bazaardb\/snapshots\/([^/]+)$/,
    paramNames: ["snapshot_id"],
    decodeErrorCode: "invalid_snapshot_id",
    handle: (request, env, params) =>
      handleUploadBazaarDbSnapshot(request, env, params.snapshot_id),
  },
  {
    method: "POST",
    pattern: /^\/ghost-battles\/([^/]+)\/replay-link$/,
    paramNames: ["battle_id"],
    decodeErrorCode: "bad_request",
    handle: (request, env, params) =>
      handleCreateReplayLink(request, env, params.battle_id),
  },
];

function matchRoute(
  route: StaticRoute,
  method: string,
  pathname: string,
): Record<string, string> | null | Response {
  if (route.method !== method) {
    return null;
  }

  const match = route.pattern.exec(pathname);
  if (match == null) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < (route.paramNames?.length ?? 0); index += 1) {
    try {
      params[route.paramNames![index]] = decodeURIComponent(match[index + 1] ?? "");
    } catch {
      return jsonError(route.decodeErrorCode ?? "bad_request", 400);
    }
  }

  return params;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight(request);
    const url = new URL(request.url);
    try {
      for (const route of Routes) {
        const match = matchRoute(route, request.method, url.pathname);
        if (match instanceof Response) {
          return withCors(request, match);
        }
        if (match != null) {
          return withCors(request, await route.handle(request, env, match));
        }
      }

      return withCors(request, jsonError("not_found", 404));
    } catch (error) {
      if (error instanceof Response) return withCors(request, error);
      logError("worker.fetch", {
        method: request.method,
        path: url.pathname,
        error: String(error),
        outcome: "unhandled_error",
      });
      // Unexpected failures still answer with the canonical error envelope and
      // CORS headers instead of a bare platform 500. The error is logged above.
      return withCors(request, jsonError("internal_error", 500));
    }
  },
};
