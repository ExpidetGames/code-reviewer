// SPDX-License-Identifier: Apache-2.0

// Pins down the HMAC signing of values that travel through the browser: a signed value verifies for
// its own purpose and secret only, and any change to it makes it fail.
import { describe, expect, it } from "vitest";
import { signValue, verifySignedValue } from "./sign.ts";

const SECRET = "test-app-secret-0123456789-0123456789-abc";

describe("signValue and verifySignedValue", () => {
  // #97-SU-18
  it("verifies a value it signed and returns it unchanged", () => {
    const token = signValue(SECRET, "state-signing", '{"nonce":"abc","n":1}');

    expect(verifySignedValue(SECRET, "state-signing", token)).toBe(
      '{"nonce":"abc","n":1}',
    );
  });

  it("refuses a value signed with another secret", () => {
    const token = signValue(SECRET, "state-signing", "value");

    expect(verifySignedValue(`${SECRET}x`, "state-signing", token)).toBeNull();
  });

  it("refuses a value signed for another purpose", () => {
    const token = signValue(SECRET, "setup-session", "value");

    expect(verifySignedValue(SECRET, "state-signing", token)).toBeNull();
  });

  it("refuses a value whose payload or signature was changed", () => {
    const token = signValue(SECRET, "state-signing", "value");
    const [payload = "", signature = ""] = token.split(".");
    const otherPayload = Buffer.from("other").toString("base64url");
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;

    expect(
      verifySignedValue(
        SECRET,
        "state-signing",
        `${otherPayload}.${signature}`,
      ),
    ).toBeNull();
    expect(
      verifySignedValue(SECRET, "state-signing", `${payload}.${flipped}`),
    ).toBeNull();
  });

  // #97-SU-18
  it("refuses a signature or payload with characters added that decoding would skip", () => {
    const token = signValue(SECRET, "state-signing", "value");
    const [payload = "", signature = ""] = token.split(".");

    expect(verifySignedValue(SECRET, "state-signing", token)).toBe("value");
    expect(
      verifySignedValue(SECRET, "state-signing", `${payload}.${signature}!!`),
    ).toBeNull();
    expect(
      verifySignedValue(SECRET, "state-signing", `${payload}.${signature}=`),
    ).toBeNull();
    expect(
      verifySignedValue(SECRET, "state-signing", `${payload}*.${signature}`),
    ).toBeNull();
    expect(
      verifySignedValue(
        SECRET,
        "state-signing",
        `${payload}.${signature.slice(0, 20)}*${signature.slice(20)}`,
      ),
    ).toBeNull();
  });

  it.each(["", ".", "abc", "a.b.c", "payload.", ".signature", "x.y"])(
    "refuses the malformed token %j without throwing",
    (token) => {
      expect(verifySignedValue(SECRET, "state-signing", token)).toBeNull();
    },
  );
});
