import { logWarn } from "../observability";

type R2PutValue = Parameters<R2Bucket["put"]>[1];
type R2PutOptions = Parameters<R2Bucket["put"]>[2];

type CleanupOutcome =
  | "deleted"
  | "kept"
  | "orphaned"
  | "reference_lookup_failed";

type ProjectFailure<TCommitted> = {
  ok: false;
  error: unknown;
  committed: TCommitted | null;
  cleanup: CleanupOutcome;
  cleanupError?: unknown;
  referenceLookupError?: unknown;
};

type ProjectSuccess<TProject> = {
  ok: true;
  value: TProject;
};

export type PutThenProjectResult<TProject, TCommitted> =
  | ProjectSuccess<TProject>
  | ProjectFailure<TCommitted>;

/**
 * Shared warn-level logging for a failed putThenProject result. `outcomeMap`
 * is keyed by every CleanupOutcome so adding a variant is a compile error at
 * each call site instead of a silently missing log. A map entry may be a
 * function of the raced committed row for outcomes whose log string depends
 * on it (e.g. run-bundles' raced-object `deleted` variant).
 */
export function logProjectFailure<TCommitted>(
  event: string,
  idFields: Record<string, unknown>,
  failure: ProjectFailure<TCommitted>,
  outcomeMap: Record<CleanupOutcome, string | ((committed: TCommitted | null) => string)>,
): void {
  const outcome = outcomeMap[failure.cleanup];
  logWarn(event, {
    ...idFields,
    error: String(failure.error),
    ...(failure.cleanup === "orphaned"
      ? { cleanup_error: String(failure.cleanupError) }
      : {}),
    ...(failure.cleanup === "reference_lookup_failed"
      ? { reference_lookup_error: String(failure.referenceLookupError) }
      : {}),
    outcome: typeof outcome === "function" ? outcome(failure.committed) : outcome,
  });
}

export async function putThenProject<TProject, TCommitted>(options: {
  bucket: R2Bucket;
  objectKey: string;
  value: R2PutValue;
  putOptions?: R2PutOptions;
  project: () => Promise<TProject>;
  findCommitted: () => Promise<TCommitted | null>;
  isObjectReferenced: (committed: TCommitted) => boolean;
  onPutSucceeded?: () => void;
  onPutFailed?: (error: unknown) => void;
}): Promise<PutThenProjectResult<TProject, TCommitted>> {
  try {
    await options.bucket.put(options.objectKey, options.value, options.putOptions);
    options.onPutSucceeded?.();
  } catch (error) {
    options.onPutFailed?.(error);
    throw error;
  }

  try {
    return { ok: true, value: await options.project() };
  } catch (error) {
    let committed: TCommitted | null;
    try {
      committed = await options.findCommitted();
    } catch (referenceLookupError) {
      return {
        ok: false,
        error,
        committed: null,
        cleanup: "reference_lookup_failed",
        referenceLookupError,
      };
    }

    if (committed != null && options.isObjectReferenced(committed)) {
      return { ok: false, error, committed, cleanup: "kept" };
    }

    try {
      await options.bucket.delete(options.objectKey);
      return { ok: false, error, committed, cleanup: "deleted" };
    } catch (cleanupError) {
      return { ok: false, error, committed, cleanup: "orphaned", cleanupError };
    }
  }
}
