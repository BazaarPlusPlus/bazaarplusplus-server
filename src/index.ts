import type { Env } from "./env";
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
      return withCors(request, jsonError("not_found", 404));
    } catch (error) {
      if (error instanceof Response) return withCors(request, error);
      throw error;
    }
  },
};
