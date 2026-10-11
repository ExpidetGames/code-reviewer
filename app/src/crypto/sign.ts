// HMAC-SHA256 signing of small values that make a round trip through the browser (a cookie, a state
// parameter). The key is derived per purpose (keys.ts); the comparison is constant time. A signed
// value is `<base64url value>.<base64url mac>`: it is integrity protected, not secret.
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey, type KeyPurpose } from "./keys.ts";

const MAC_LENGTH = 32;

function mac(appSecret: string, purpose: KeyPurpose, payload: string): Buffer {
  return createHmac("sha256", deriveKey(appSecret, purpose))
    .update(payload, "utf8")
    .digest();
}

export function signValue(
  appSecret: string,
  purpose: KeyPurpose,
  value: string,
): string {
  const payload = Buffer.from(value, "utf8").toString("base64url");
  return `${payload}.${mac(appSecret, purpose, payload).toString("base64url")}`;
}

/** The signed value, or null when the signature does not match or the token is not well formed. */
export function verifySignedValue(
  appSecret: string,
  purpose: KeyPurpose,
  token: string,
): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload = "", signature = ""] = parts;
  if (payload === "" || signature === "") return null;
  const given = Buffer.from(signature, "base64url");
  if (given.length !== MAC_LENGTH) return null;
  // Decoding skips characters that are not base64url, so a signature (or payload) with junk added
  // would decode to the same bytes. Only the canonical spelling counts.
  if (given.toString("base64url") !== signature) return null;
  if (Buffer.from(payload, "base64url").toString("base64url") !== payload)
    return null;
  if (!timingSafeEqual(given, mac(appSecret, purpose, payload))) return null;
  return Buffer.from(payload, "base64url").toString("utf8");
}
