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
