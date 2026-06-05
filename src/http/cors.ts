const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = [
  "content-type",
  // Reserved for signed mod-facing endpoints; no handler consumes these today.
  "x-bpp-timestamp",
  "x-bpp-content-sha256",
  "x-bpp-signature",
].join(", ");

function resolveAllowOrigin(request: Request): string {
  return request.headers.get("origin")?.trim() || "*";
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", value);
    return;
  }

  const normalized = existing
    .split(",")
    .map((entry) => entry.trim().toLowerCase());
  if (!normalized.includes(value.toLowerCase())) {
    headers.set("vary", `${existing}, ${value}`);
  }
}

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", resolveAllowOrigin(request));
  headers.set("access-control-allow-methods", ALLOWED_METHODS);
  headers.set("access-control-allow-headers", ALLOWED_HEADERS);
  appendVary(headers, "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(request: Request): Response {
  const headers = new Headers();
  headers.set("access-control-allow-origin", resolveAllowOrigin(request));
  headers.set("access-control-allow-methods", ALLOWED_METHODS);
  headers.set("access-control-allow-headers", ALLOWED_HEADERS);
  headers.set("access-control-max-age", "86400");
  appendVary(headers, "Origin");
  appendVary(headers, "Access-Control-Request-Method");
  appendVary(headers, "Access-Control-Request-Headers");

  return new Response(null, {
    status: 204,
    headers,
  });
}
