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

const IsoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = IsoDateTimePattern.exec(value.trim());
  if (match == null) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const fractional = match[7] ?? "";
  const timeZone = match[8];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const millisecond = fractional
    ? Number.parseInt(fractional.padEnd(3, "0").slice(0, 3), 10)
    : 0;
  const offsetMinutes = parseTimeZoneOffsetMinutes(timeZone);
  if (offsetMinutes == null) {
    return null;
  }

  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  localAsUtc.setUTCHours(hour, minute, second, millisecond);
  const utcMs = localAsUtc.getTime() - offsetMinutes * 60 * 1000;
  if (!Number.isFinite(utcMs)) {
    return null;
  }

  return new Date(utcMs).toISOString();
}

export function optionalIsoDateTime(value: unknown): string | null {
  if (value == null || (typeof value === "string" && value.trim().length === 0)) {
    return null;
  }

  return normalizeIsoDateTime(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseTimeZoneOffsetMinutes(timeZone: string): number | null {
  if (timeZone === "Z") {
    return 0;
  }

  const sign = timeZone[0] === "-" ? -1 : 1;
  const hours = Number.parseInt(timeZone.slice(1, 3), 10);
  const minutes = Number.parseInt(timeZone.slice(4, 6), 10);
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return sign * (hours * 60 + minutes);
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
