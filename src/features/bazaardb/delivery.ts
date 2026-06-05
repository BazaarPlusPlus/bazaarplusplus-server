export const LeaseSeconds = 600;
export const MaxDeliveryAttempts = 3;
export const PeekMaxItems = 10;

export type DeliveryRow = {
  snapshot_id: string;
  r2_key: string;
};

export type ClaimedDeliveryRow = DeliveryRow & {
  uploaded_at_utc: string;
};

export type OutstandingLeaseRow = {
  lease_peek_id: string;
  lease_until_utc: string;
};

export function createPeekId(): string {
  return `pk_${crypto.randomUUID()}`;
}

export function requestedPeekLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(PeekMaxItems, Math.floor(value)))
    : PeekMaxItems;
}
