// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the check of GitHub's X-Hub-Signature-256 header: only "sha256=" plus the hex HMAC of the
// exact body counts, every malformed value is refused without throwing, and the comparison goes
// through a constant time function.
import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isValidSignature } from "./webhook-signature.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = "a-test-secret";
const BODY = '{"action":"opened","number":7}';
const hex = (body: string, secret = SECRET, algorithm = "sha256") =>
  createHmac(algorithm, secret).update(body).digest("hex");

describe("verifying a signature", () => {
  it("accepts the HMAC-SHA256 of the exact body", () => {
    expect(isValidSignature(BODY, `sha256=${hex(BODY)}`, SECRET)).toBe(true);
  });

  it("refuses a signature of another body or made with another secret", () => {
    expect(isValidSignature(BODY, `sha256=${hex("{}")}`, SECRET)).toBe(false);
    expect(isValidSignature(BODY, `sha256=${hex(BODY, "other")}`, SECRET)).toBe(
      false,
    );
  });

  // CR-22-T06
  it.each([
    ["a sha1 prefix", `sha1=${hex(BODY, SECRET, "sha1")}`],
    ["no prefix", hex(BODY)],
    ["a missing header", null],
    ["an empty header", ""],
    ["only the prefix", "sha256="],
    ["hex that is not hex", `sha256=${"zz".repeat(32)}`],
    ["a signature that is too short", `sha256=${hex(BODY).slice(0, 62)}`],
    ["a signature that is too long", `sha256=${hex(BODY)}00`],
    ["an upper case prefix", `SHA256=${hex(BODY)}`],
    ["non ASCII characters", `sha256=${"é".repeat(64)}`],
  ])("refuses %s without throwing", (_name, header) => {
    expect(() => isValidSignature(BODY, header, SECRET)).not.toThrow();
    expect(isValidSignature(BODY, header, SECRET)).toBe(false);
  });

  it("checks the signature against the bytes that were received, not against decoded text", () => {
    const received = new Uint8Array([0x7b, 0xff, 0x7d]);
    const overBytes = createHmac("sha256", SECRET)
      .update(received)
      .digest("hex");
    const overDecodedText = hex(new TextDecoder().decode(received));

    expect(isValidSignature(received, `sha256=${overBytes}`, SECRET)).toBe(
      true,
    );
    expect(
      isValidSignature(received, `sha256=${overDecodedText}`, SECRET),
    ).toBe(false);
  });

  // CR-22-T06
  it("compares a signature of the right length in constant time", () => {
    vi.mocked(timingSafeEqual).mockClear();

    isValidSignature(BODY, `sha256=${"0".repeat(64)}`, SECRET);

    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
