// SPDX-License-Identifier: Apache-2.0

// Pins down the key derivation: the same secret, purpose and version always give the same key, and
// anything that differs gives another one, so a key for one use cannot stand in for another.
import { describe, expect, it } from "vitest";
import { deriveKey, KEY_PURPOSES } from "./keys.ts";

const SECRET = "test-app-secret-0123456789-0123456789-abc";

describe("deriveKey", () => {
  it("derives the same 32 byte key every time for one secret and purpose", () => {
    const first = deriveKey(SECRET, "secret-encryption");
    const second = deriveKey(SECRET, "secret-encryption");

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
  });

  it("derives a different key for every purpose", () => {
    const keys = KEY_PURPOSES.map((purpose) =>
      deriveKey(SECRET, purpose).toString("hex"),
    );

    expect(new Set(keys).size).toBe(KEY_PURPOSES.length);
  });

  it("derives a different key for another secret or another key version", () => {
    const base = deriveKey(SECRET, "state-signing").toString("hex");

    expect(deriveKey(`${SECRET}x`, "state-signing").toString("hex")).not.toBe(
      base,
    );
    expect(deriveKey(SECRET, "state-signing", 2).toString("hex")).not.toBe(
      base,
    );
  });

  it("never returns the secret itself", () => {
    const key = deriveKey(SECRET, "setup-session");

    expect(key.toString("utf8")).not.toContain(SECRET);
    expect(key.equals(Buffer.from(SECRET))).toBe(false);
  });
});
