import type { Env } from "./env";

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
