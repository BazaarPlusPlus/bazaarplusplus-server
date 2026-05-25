export function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function optionalTrimmedString(value: unknown): string | null {
  const trimmed = trimString(value);
  return trimmed ? trimmed : null;
}

export function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseClampedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

export function absolutePath(request: Request): string {
  return new URL(request.url).pathname || "/";
}
