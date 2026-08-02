import { MAX_BUNDLE_BYTES } from "../domain/limits";
import { HttpError, invalidBundle } from "../http/errors";
import type { ValidatedBundleDescriptor } from "./manifest";
import { BUNDLE_PREFIX_BYTES } from "./prefix";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface SegmentDigest {
  start: number;
  end: number;
  expected: string;
  writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>;
  digest: Promise<ArrayBuffer>;
}

export function validatedBundleStream(
  source: ReadableStream<Uint8Array>,
  descriptor: ValidatedBundleDescriptor,
  expectedBundleDigest: string | null,
): { stream: ReadableStream<Uint8Array>; digest: Promise<string> } {
  const bundleDigest = new crypto.DigestStream("SHA-256");
  const bundleWriter = bundleDigest.getWriter();
  const payloadStart = BUNDLE_PREFIX_BYTES + descriptor.manifestBytes;
  const segmentDigests: SegmentDigest[] = [];

  for (const segment of [descriptor.run, descriptor.screenshot].filter(
    (value): value is NonNullable<typeof value> => value !== null,
  )) {
    const digest = new crypto.DigestStream("SHA-256");
    segmentDigests.push({
      start: payloadStart + segment.offset,
      end: payloadStart + segment.offset + segment.length,
      expected: segment.sha256,
      writer: digest.getWriter(),
      digest: digest.digest,
    });
  }

  let position = 0;
  let resolveDigest!: (digest: string) => void;
  let rejectDigest!: (error: unknown) => void;
  const digestResult = new Promise<string>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  void digestResult.catch(() => undefined);

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const nextPosition = position + chunk.byteLength;
      if (nextPosition > descriptor.objectBytes) {
        throw new HttpError(
          nextPosition >= MAX_BUNDLE_BYTES ? 413 : 400,
          nextPosition >= MAX_BUNDLE_BYTES ? "bundle_too_large" : "invalid_content_length",
          "Actual Bundle length exceeds Content-Length",
          false,
        );
      }
      await bundleWriter.write(chunk);
      for (const segment of segmentDigests) {
        const start = Math.max(position, segment.start);
        const end = Math.min(nextPosition, segment.end);
        if (start < end) {
          await segment.writer.write(chunk.subarray(start - position, end - position));
        }
      }
      position = nextPosition;
      controller.enqueue(chunk);
    },
    async flush() {
      try {
        if (position !== descriptor.objectBytes) {
          throw new HttpError(
            400,
            "invalid_content_length",
            "Actual Bundle length differs from Content-Length",
            false,
          );
        }
        if (descriptor.describedObjectBytes < descriptor.objectBytes) {
          throw invalidBundle("undeclared_trailing_bytes", "Bundle has undeclared trailing bytes");
        }
        if (descriptor.describedObjectBytes > descriptor.objectBytes) {
          throw invalidBundle("segment_out_of_bounds", "A segment extends beyond the Bundle body");
        }
        await Promise.all([bundleWriter.close(), ...segmentDigests.map(({ writer }) => writer.close())]);
        const segmentHashes = await Promise.all(segmentDigests.map(({ digest }) => digest.then(hex)));
        if (segmentHashes.some((digest, index) => digest !== segmentDigests[index].expected)) {
          throw new HttpError(
            422,
            "segment_digest_mismatch",
            "A Bundle segment digest does not match its manifest",
            false,
          );
        }
        const actual = hex(await bundleDigest.digest);
        if (expectedBundleDigest !== null && actual !== expectedBundleDigest) {
          throw new HttpError(
            422,
            "bundle_digest_mismatch",
            "Bundle digest does not match Content-Digest",
            false,
          );
        }
        resolveDigest(actual);
      } catch (error) {
        rejectDigest(error);
        throw error;
      }
    },
    cancel(reason) {
      rejectDigest(reason);
    },
  });

  return { stream: source.pipeThrough(transform), digest: digestResult };
}
