import { expect, test } from "vitest";

import { putThenProject } from "../src/storage/putThenProject";

function fakeBucket(deletedKeys: string[]): R2Bucket {
  return {
    put: async () => null,
    delete: async (key: string) => {
      deletedKeys.push(key);
    },
  } as unknown as R2Bucket;
}

test("putThenProject keeps an uploaded object when the committed row references it", async () => {
  const deletedKeys: string[] = [];
  const result = await putThenProject({
    bucket: fakeBucket(deletedKeys),
    objectKey: "objects/current",
    value: new Uint8Array([1]),
    project: async () => {
      throw new Error("D1 failed");
    },
    findCommitted: async () => ({ object_key: "objects/current" }),
    isObjectReferenced: (committed) => committed.object_key === "objects/current",
  });

  expect(result).toMatchObject({ ok: false, cleanup: "kept" });
  expect(deletedKeys).toEqual([]);
});

test("putThenProject deletes an uploaded object when no committed row references it", async () => {
  const deletedKeys: string[] = [];
  const result = await putThenProject({
    bucket: fakeBucket(deletedKeys),
    objectKey: "objects/orphan",
    value: new Uint8Array([1]),
    project: async () => {
      throw new Error("D1 failed");
    },
    findCommitted: async () => ({ object_key: "objects/other" }),
    isObjectReferenced: (committed) => committed.object_key === "objects/orphan",
  });

  expect(result).toMatchObject({ ok: false, cleanup: "deleted" });
  expect(deletedKeys).toEqual(["objects/orphan"]);
});

test("putThenProject does not delete when the committed-reference lookup fails", async () => {
  const deletedKeys: string[] = [];
  const result = await putThenProject({
    bucket: fakeBucket(deletedKeys),
    objectKey: "objects/unknown",
    value: new Uint8Array([1]),
    project: async () => {
      throw new Error("D1 failed");
    },
    findCommitted: async () => {
      throw new Error("lookup failed");
    },
    isObjectReferenced: (committed: { object_key: string }) =>
      committed.object_key === "objects/unknown",
  });

  expect(result).toMatchObject({ ok: false, cleanup: "reference_lookup_failed" });
  expect(deletedKeys).toEqual([]);
});
