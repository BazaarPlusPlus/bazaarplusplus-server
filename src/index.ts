import type { Env } from "./env";
import { jsonError, jsonResponse } from "./http/json";

function requestId(request: Request): string {
  return request.headers.get("CF-Ray") ?? crypto.randomUUID();
}

export default {
  fetch(request: Request, _env: Env): Response {
    const id = requestId(request);
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method === "GET") {
        return jsonResponse(
          {
            status: "ok",
            server_time_ms: Date.now(),
          },
          {
            status: 200,
            requestId: id,
          },
        );
      }

      return jsonError(
        {
          code: "method_not_allowed",
          message: "Method not allowed",
          retryable: false,
        },
        405,
        id,
        { Allow: "GET" },
      );
    }

    return jsonError(
      {
        code: "not_found",
        message: "Route not found",
        retryable: false,
      },
      404,
      id,
    );
  },
} satisfies ExportedHandler<Env>;
