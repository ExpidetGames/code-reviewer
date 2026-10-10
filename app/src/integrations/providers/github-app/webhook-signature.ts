// Checks GitHub's `X-Hub-Signature-256` header: "sha256=" and the hex HMAC-SHA256 of the raw body
// with the webhook secret. Compared in constant time; any malformed input is simply "not valid".
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export function isValidSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (header === null || !header.startsWith(PREFIX)) return false;
  const expected = Buffer.from(
    `${PREFIX}${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
