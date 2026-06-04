import { base64ToBytes } from "../crypto/base64";

import { jsonError } from "./json";

// All validators throw a Response on failure. The fetch handler in index.ts
// catches `instanceof Response` and forwards it through withCors, so handlers
// can stay flat and skip explicit error-branch plumbing.

const ObjectKeySegmentPattern = /^[A-Za-z0-9._-]{1,128}$/;

type FieldType =
  | "string"
  | "string?"
  | "finiteNumber"
  | "finiteNumber?"
  | "base64"
  | "boolean?";

type FieldValue<T extends FieldType> = T extends "string"
  ? string
  : T extends "string?"
    ? string | null
    : T extends "finiteNumber"
      ? number
      : T extends "finiteNumber?"
        ? number | null
        : T extends "base64"
          ? Uint8Array
          : T extends "boolean?"
            ? boolean | null
            : never;

type FieldSpec<T extends FieldType = FieldType> = {
  type: T;
  // errorCode overrides the default `invalid_<field>` to match wire-compatible codes.
  errorCode?: string;
};

type Schema = Record<string, FieldType | FieldSpec>;

type Parsed<S extends Schema> = {
  [K in keyof S]: S[K] extends FieldType
    ? FieldValue<S[K]>
    : S[K] extends FieldSpec<infer T>
      ? FieldValue<T>
      : never;
};

function normalizeSpec(spec: FieldType | FieldSpec): FieldSpec {
  return typeof spec === "string" ? { type: spec } : spec;
}

function fail(errorCode: string, status = 400): never {
  throw jsonError(errorCode, status);
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

function parseField(
  fieldName: string,
  raw: unknown,
  spec: FieldSpec,
): unknown {
  const errorCode = spec.errorCode ?? `invalid_${fieldName}`;

  switch (spec.type) {
    case "string": {
      const value = trimmed(raw);
      if (value == null) {
        fail(errorCode);
      }
      return value;
    }
    case "string?":
      return trimmed(raw);
    case "finiteNumber": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        fail(errorCode);
      }
      return raw;
    }
    case "finiteNumber?":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    case "base64": {
      const bytes = decodeBase64(raw);
      if (bytes == null) {
        fail(errorCode);
      }
      return bytes;
    }
    case "boolean?":
      return typeof raw === "boolean" ? raw : null;
  }
}

/**
 * Parse and validate a JSON body against a declarative schema.
 * Returns a typed object; throws a Response (caught by the fetch handler)
 * on the first invalid required field.
 */
export function parseBody<S extends Schema>(
  rawBody: unknown,
  schema: S,
): Parsed<S> {
  const source =
    typeof rawBody === "object" && rawBody != null
      ? (rawBody as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {};
  for (const [fieldName, rawSpec] of Object.entries(schema)) {
    out[fieldName] = parseField(fieldName, source[fieldName], normalizeSpec(rawSpec));
  }
  return out as Parsed<S>;
}

/**
 * Sanitize a single object-key path segment. Returns null on invalid input
 * (caller decides whether that's a 400 or an internal error).
 */
export function objectKeySegment(value: string): string | null {
  return ObjectKeySegmentPattern.test(value) ? value : null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function hasPngMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) {
    return false;
  }
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (bytes[index] !== PNG_MAGIC[index]) {
      return false;
    }
  }
  return true;
}
