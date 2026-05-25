import { bytesToBase64 } from "./base64";

export async function sha256Base64(
  payload: ArrayBuffer | Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return bytesToBase64(new Uint8Array(digest));
}
