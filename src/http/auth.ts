import type { Env } from "../env";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time check for `Authorization: Bearer <env[tokenVar]>`.
 * Used by the BazaarDB pull endpoints (manifest, image proxy).
 *
 * No other handler verifies a request signature today — `src/crypto/signature.ts`
 * existed but had no callers, so it was removed in the v4 refactor. The
 * `x-bpp-*` headers are kept in the CORS allow-list against the day signed
 * uploads come back.
 */
export function requireBearer(
  request: Request,
  env: Env,
  tokenVar: "BAZAARDB_PULL_TOKEN",
): Response | null {
  const header = request.headers.get("Authorization");
  if (header == null || !header.startsWith(BEARER_PREFIX)) {
    return new Response(null, { status: 401 });
  }
  const presented = header.slice(BEARER_PREFIX.length).trim();
  const expected = (env[tokenVar] ?? "").trim();
  if (expected.length === 0 || !constantTimeEquals(presented, expected)) {
    return new Response(null, { status: 401 });
  }
  return null;
}
