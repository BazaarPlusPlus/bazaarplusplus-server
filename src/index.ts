import type { Env } from "./env";
import { handleQueryGhostBattles } from "./features/ghostBattles/query";
import { handleCreateReplayLink } from "./features/ghostBattles/replayLink";
import { handleUploadRunBundle } from "./features/runBundles/upload";
import { preflight, withCors } from "./http/cors";
import { json, jsonError } from "./http/json";

type StaticRoute = {
  method: string;
  path: string;
  handle: (request: Request, env: Env) => Promise<Response> | Response;
};

const StaticRoutes: StaticRoute[] = [
  { method: "GET", path: "/health", handle: () => json({ ok: true }) },
  { method: "POST", path: "/run-bundles", handle: handleUploadRunBundle },
  { method: "GET", path: "/ghost-battles", handle: handleQueryGhostBattles },
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
