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
 * Note: uploadBazaarDbScreenshot intentionally returns `{status:"rejected",reason}`
 * — that shape is fixed by the mod-side ingest contract, not a drift.
 */
export function jsonError(errorCode: string, status = 400): Response {
  return json({ error: errorCode }, { status });
}

export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Response("expected application/json", { status: 415 });
  }

  return request.json();
}
