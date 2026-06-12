export const LeaseSeconds = 600;
export const MaxDeliveryAttempts = 3;
// Default keeps the original wire behavior (no/invalid max_items still claims
// 10); only an explicit max_items can opt in to larger batches. PeekMaxItems
// also caps confirm's snapshot_ids and must stay well under D1's 100
// bound-parameter limit (confirm binds N + 3).
export const PeekDefaultItems = 10;
export const PeekMaxItems = 50;

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
    : PeekDefaultItems;
}
