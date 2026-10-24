// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  createHandoffToken,
  hashHandoffToken,
  isWellFormedHandoffToken,
} from "./token.ts";

describe("the handoff token", () => {
  // #284-T02
  it("is 256 random bits, different every time, and well formed", () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => createHandoffToken()),
    );
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toHaveLength(43);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isWellFormedHandoffToken(token)).toBe(true);
    }
  });

  // #284-T02
  it("is stored as the SHA-256 hash, which is not the token", () => {
    const token = createHandoffToken();
    const hash = hashHandoffToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashHandoffToken(token)).toBe(hash);
    expect(hashHandoffToken(createHandoffToken())).not.toBe(hash);
  });

  // #284-T04
  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(44)],
    ["a character outside base64url", `${"a".repeat(42)}+`],
    ["white space", `${"a".repeat(42)} `],
    ["not a string", 7],
    ["null", null],
  ])("does not take %s for a token", (_name, value) => {
    expect(isWellFormedHandoffToken(value)).toBe(false);
  });
});
