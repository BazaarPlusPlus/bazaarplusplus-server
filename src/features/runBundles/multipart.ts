// Byte-level multipart/form-data parser for run-bundle uploads. Pure and
// dependency-free; only the part names "metadata"/"artifact" couple it to the
// run-bundle wire contract.

export type RunBundleParts = {
  metadata: string | null;
  artifact: {
    bytes: Uint8Array;
    contentType: string;
  } | null;
};

export function isMultipart(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("multipart/form-data");
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    bytes[index] = value.charCodeAt(index) & 0x7f;
  }
  return bytes;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) {
    return from;
  }

  const lastStart = haystack.length - needle.length;
  for (let index = Math.max(0, from); index <= lastStart; index++) {
    let matched = true;
    for (let needleIndex = 0; needleIndex < needle.length; needleIndex++) {
      if (haystack[index + needleIndex] !== needle[needleIndex]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }

  return -1;
}

export function parseMultipartBoundary(contentType: string | null): string | null {
  const match = contentType?.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2]?.trim();
  return boundary && boundary.length > 0 ? boundary : null;
}

function parseHeaderBlock(headersText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headersText.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return headers;
}

function parseContentDispositionName(contentDisposition: string | undefined): string | null {
  const match = contentDisposition?.match(/(?:^|;)\s*name=(?:"([^"]*)"|([^;]+))/i);
  const name = match?.[1] ?? match?.[2]?.trim();
  return name && name.length > 0 ? name : null;
}

function findHeaderTerminator(
  body: Uint8Array,
  from: number,
): { index: number; length: number } | null {
  const crlf = asciiBytes("\r\n\r\n");
  const lf = asciiBytes("\n\n");
  const crlfIndex = indexOfBytes(body, crlf, from);
  const lfIndex = indexOfBytes(body, lf, from);
  if (crlfIndex < 0 && lfIndex < 0) {
    return null;
  }
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, length: crlf.length };
  }
  return { index: lfIndex, length: lf.length };
}

function findNextBoundary(
  body: Uint8Array,
  boundary: string,
  from: number,
): { index: number; prefixLength: number } | null {
  const crlfBoundary = asciiBytes(`\r\n--${boundary}`);
  const lfBoundary = asciiBytes(`\n--${boundary}`);
  const crlfIndex = indexOfBytes(body, crlfBoundary, from);
  const lfIndex = indexOfBytes(body, lfBoundary, from);
  if (crlfIndex < 0 && lfIndex < 0) {
    return null;
  }
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, prefixLength: 2 };
  }
  return { index: lfIndex, prefixLength: 1 };
}

export function parseMultipartBytes(body: Uint8Array, boundary: string): RunBundleParts | null {
  const decoder = new TextDecoder();
  const boundaryLine = asciiBytes(`--${boundary}`);
  const parts: RunBundleParts = { metadata: null, artifact: null };
  let cursor = indexOfBytes(body, boundaryLine, 0);
  if (cursor < 0) {
    return null;
  }

  while (cursor >= 0 && cursor < body.length) {
    let afterBoundary = cursor + boundaryLine.length;
    if (body[afterBoundary] === 45 && body[afterBoundary + 1] === 45) {
      break;
    }
    if (body[afterBoundary] === 13 && body[afterBoundary + 1] === 10) {
      afterBoundary += 2;
    } else if (body[afterBoundary] === 10) {
      afterBoundary += 1;
    } else {
      return null;
    }

    const headerTerminator = findHeaderTerminator(body, afterBoundary);
    if (headerTerminator == null) {
      return null;
    }
    const headers = parseHeaderBlock(
      decoder.decode(body.slice(afterBoundary, headerTerminator.index)),
    );
    const partStart = headerTerminator.index + headerTerminator.length;
    const nextBoundary = findNextBoundary(body, boundary, partStart);
    if (nextBoundary == null) {
      return null;
    }

    const name = parseContentDispositionName(headers["content-disposition"]);
    const contentType = headers["content-type"]?.split(";")[0]?.trim() ?? "";
    const partBytes = body.slice(partStart, nextBoundary.index);
    if (name === "metadata") {
      parts.metadata = decoder.decode(partBytes);
    } else if (name === "artifact") {
      parts.artifact = { bytes: partBytes, contentType };
    }

    cursor = nextBoundary.index + nextBoundary.prefixLength;
  }

  return parts;
}
