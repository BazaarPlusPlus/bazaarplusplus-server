export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Canonical error response: `{"error":"<code>"}` with the given status.
 * Use this instead of `json({ error: "..." }, { status })` so the wire shape
 * stays consistent across handlers.
 *
 * Upload handlers that need a distinct wire contract should still use this helper
 * for canonical `{"error":"<code>"}` failures unless their API doc says otherwise.
 */
export function jsonError(errorCode: string, status = 400): Response {
  return json({ error: errorCode }, { status });
}

export function requestMediaType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
}

export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.text();
  if (body.trim().length === 0) {
    return {};
  }

  if (requestMediaType(request) !== "application/json") {
    return {};
  }

  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed != null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
