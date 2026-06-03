import type { Env } from "./env";
import { handleConfirmBazaarDbSnapshots } from "./features/bazaardb/confirm";
import { handlePeekBazaarDbSnapshots } from "./features/bazaardb/peek";
import { handleUploadBazaarDbSnapshot } from "./features/bazaardb/upload";
import { handleQueryGhostBattles } from "./features/ghostBattles/query";
import { handleCreateReplayLink } from "./features/ghostBattles/replayLink";
import { handleHealth } from "./features/health";
import { handleUploadRunBundle } from "./features/runBundles/upload";
import { preflight, withCors } from "./http/cors";
import { jsonError } from "./http/json";

type StaticRoute = {
  method: string;
  path: string;
  handle: (request: Request, env: Env) => Promise<Response> | Response;
};

const StaticRoutes: StaticRoute[] = [
  { method: "GET", path: "/health", handle: () => handleHealth() },
  { method: "POST", path: "/run-bundles", handle: handleUploadRunBundle },
  { method: "GET", path: "/ghost-battles", handle: handleQueryGhostBattles },
  { method: "POST", path: "/bazaardb/peek", handle: handlePeekBazaarDbSnapshots },
  { method: "POST", path: "/bazaardb/confirm", handle: handleConfirmBazaarDbSnapshots },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight(request);
    try {
      const url = new URL(request.url);
      const route = StaticRoutes.find(
        (r) => r.method === request.method && r.path === url.pathname,
      );
      if (route) return withCors(request, await route.handle(request, env));

      const bazaarDbSnapshotMatch = url.pathname.match(/^\/bazaardb\/snapshots\/([^/]+)$/);
      if (request.method === "POST" && bazaarDbSnapshotMatch) {
        let snapshotId: string;
        try {
          snapshotId = decodeURIComponent(bazaarDbSnapshotMatch[1] ?? "");
        } catch {
          return withCors(request, jsonError("invalid_snapshot_id", 400));
        }
        return withCors(request, await handleUploadBazaarDbSnapshot(request, env, snapshotId));
      }

      const replayLinkMatch = url.pathname.match(/^\/ghost-battles\/([^/]+)\/replay-link$/);
      if (request.method === "POST" && replayLinkMatch) {
        let battleId: string;
        try {
          battleId = decodeURIComponent(replayLinkMatch[1] ?? "");
        } catch {
          return withCors(request, jsonError("bad_request", 400));
        }
        return withCors(request, await handleCreateReplayLink(request, env, battleId));
      }

      return withCors(request, jsonError("not_found", 404));
    } catch (error) {
      if (error instanceof Response) return withCors(request, error);
      throw error;
    }
  },
};
