export const BazaarDbBucketName = "bazaarplusplus-bazaardb-assets-v4";
export const LeaseSeconds = 600;
export const MaxDeliveryAttempts = 3;
export const PeekMaxItems = 10;

export type DeliveryRow = {
  snapshot_id: string;
  r2_key: string;
};

export type OutstandingLeaseRow = {
  lease_peek_id: string;
  lease_until_utc: string;
};

export function createPeekId(): string {
  return `pk_${crypto.randomUUID()}`;
}

export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.text();
  if (body.trim().length === 0) {
    return {};
  }
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {};
  }
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed != null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function requestedPeekLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(PeekMaxItems, Math.floor(value)))
    : PeekMaxItems;
}
