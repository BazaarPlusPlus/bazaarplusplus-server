import type { Env } from "./env";
import { authenticateServiceToken, type ServiceScope } from "./http/auth";
import { HttpError } from "./http/errors";
import { jsonError, jsonResponse } from "./http/json";
import { ingestBundle } from "./modules/bundle-ingest";
import { collectBundles } from "./modules/bundle-collection";
import { discoverGhostBattles } from "./modules/ghost-battle-discovery";
import { claimDeliveries, settleDeliveries } from "./modules/bazaardb-delivery";
import { logError } from "./observability";

function requestId(request: Request): string {
  return request.headers.get("CF-Ray") ?? crypto.randomUUID();
}

const ROUTES = new Map<string, readonly string[]>([
  ["/health", ["GET"]],
  ["/bundles", ["GET", "POST"]],
  ["/ghost-battles", ["GET"]],
  ["/bazaardb/deliveries/claim", ["POST"]],
  ["/bazaardb/deliveries/settle", ["POST"]],
]);

function optionsResponse(path: string, methods: readonly string[]): Response {
  const allow = methods.join(", ");
  const headers = new Headers({
    Allow: allow,
    "Access-Control-Allow-Methods": allow,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Content-Digest",
    "Access-Control-Max-Age": "86400",
  });
  if (path === "/health" || path === "/ghost-battles") {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  return new Response(null, { status: 204, headers });
}

function authError(
  request: Request,
  env: Env,
  scope: ServiceScope,
  id: string,
): Response | null {
  const outcome = authenticateServiceToken(request, env, scope);
  if (outcome === "authorized") {
    return null;
  }
  if (outcome === "insufficient_scope") {
    return jsonError(
      {
        code: "insufficient_scope",
        message: "The service token does not grant access to this route",
        retryable: false,
      },
      403,
      id,
    );
  }
  if (outcome === "invalid_configuration") {
    return jsonError(
      {
        code: "internal_error",
        message: "Service token configuration is invalid",
        retryable: true,
      },
      500,
      id,
    );
  }
  return jsonError(
    {
      code: "unauthorized",
      message: "A valid service token is required",
      retryable: false,
    },
    401,
    id,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = requestId(request);
    const url = new URL(request.url);
    const allowedMethods = ROUTES.get(url.pathname);

    if (allowedMethods === undefined) {
      return jsonError(
        {
          code: "not_found",
          message: "Route not found",
          retryable: false,
        },
        404,
        id,
      );
    }

    if (request.method === "OPTIONS") {
      return optionsResponse(url.pathname, allowedMethods);
    }

    if (!allowedMethods.includes(request.method)) {
      return jsonError(
        {
          code: "method_not_allowed",
          message: "Method not allowed",
          retryable: false,
        },
        405,
        id,
        { Allow: allowedMethods.join(", ") },
      );
    }

    if (url.pathname === "/health") {
      return jsonResponse(
        {
          status: "ok",
          server_time_ms: Date.now(),
        },
        {
          status: 200,
          requestId: id,
          headers: { "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    if (url.pathname === "/bundles" && request.method === "GET") {
      const auth = authError(request, env, "bundle_sync", id);
      if (auth !== null) return auth;
      try {
        return jsonResponse(await collectBundles(request, env, id), {
          status: 200,
          requestId: id,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          return jsonError(
            {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
            error.status,
            id,
          );
        }
        return jsonError(
          {
            code: "internal_error",
            message: "An internal error occurred",
            retryable: true,
          },
          500,
          id,
        );
      }
    }
    if (url.pathname === "/bundles" && request.method === "POST") {
      try {
        const result = await ingestBundle(request, env, id);
        return jsonResponse(result.receipt, {
          status: result.status,
          requestId: id,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          return jsonError(
            {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
            error.status,
            id,
          );
        }
        logError("worker.internal_error", {
          request_id: id,
          route: "/bundles",
          error_name: error instanceof Error ? error.name : "unknown",
          reason: "unclassified_exception",
        });
        return jsonError(
          {
            code: "internal_error",
            message: "An internal error occurred",
            retryable: true,
          },
          500,
          id,
        );
      }
    }
    if (url.pathname.startsWith("/bazaardb/")) {
      const auth = authError(request, env, "bazaardb_delivery", id);
      if (auth !== null) return auth;
      try {
        const body =
          url.pathname === "/bazaardb/deliveries/claim"
            ? await claimDeliveries(request, env, id)
            : await settleDeliveries(request, env, id);
        return jsonResponse(body, { status: 200, requestId: id });
      } catch (error) {
        if (error instanceof HttpError) {
          return jsonError(
            {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
            error.status,
            id,
            error.headers,
          );
        }
        return jsonError(
          {
            code: "internal_error",
            message: "An internal error occurred",
            retryable: true,
          },
          500,
          id,
        );
      }
    }
    if (url.pathname === "/ghost-battles") {
      try {
        return jsonResponse(await discoverGhostBattles(request, env, id), {
          status: 200,
          requestId: id,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (error) {
        if (error instanceof HttpError) {
          const headers = new Headers(error.headers);
          headers.set("Access-Control-Allow-Origin", "*");
          return jsonError(
            {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
            error.status,
            id,
            headers,
          );
        }
        return jsonError(
          {
            code: "internal_error",
            message: "An internal error occurred",
            retryable: true,
          },
          500,
          id,
          { "Access-Control-Allow-Origin": "*" },
        );
      }
    }
    return jsonError(
      {
        code: "internal_error",
        message: "The route table is internally inconsistent",
        retryable: true,
      },
      500,
      id,
    );
  },
} satisfies ExportedHandler<Env>;
