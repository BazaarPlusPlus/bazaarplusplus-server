export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  for (const value of new Uint8Array(digest)) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

export function toBase64UrlSegment(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
