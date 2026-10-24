// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { MAX_USAGE_CURSOR_LENGTH, USAGE_SAFETY_LAG_MS } from "./contract.ts";
import {
  decodeUsageCursor,
  encodeUsageCursor,
  validateSafetyLagMs,
} from "./usage-cursor.ts";

const POSITION = {
  settledAt: "2026-10-14T12:00:01.250Z",
  id: "3f2b8c1e-5a47-4d6e-9b0a-1c2d3e4f5a6b",
};

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A text that decodes to the bytes of a valid cursor but is not what `encodeUsageCursor` writes (spare bits set). */
function nonCanonical(): string {
  const valid = encodeUsageCursor({
    settledAt: POSITION.settledAt,
    id: "abcd",
  });
  const last = ALPHABET.indexOf(valid.slice(-1));
  return `${valid.slice(0, -1)}${ALPHABET[last ^ 1]}`;
}

describe("the usage cursor", () => {
  // #278-T01
  it("round-trips a position and stays within the allowed size", () => {
    const cursor = encodeUsageCursor(POSITION);

    expect(decodeUsageCursor(cursor)).toEqual(POSITION);
    expect(cursor.length).toBeLessThanOrEqual(MAX_USAGE_CURSOR_LENGTH);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // #278-T01
  it("does not show the position in the clear", () => {
    const cursor = encodeUsageCursor(POSITION);

    expect(cursor).not.toContain(POSITION.id);
    expect(cursor).not.toContain("2026");
  });

  // #278-T06
  it.each([
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["standard base64 characters", "a+b/c=="],
    ["too long", "A".repeat(MAX_USAGE_CURSOR_LENGTH + 1)],
    ["decodes to nothing useful", "AAAA"],
    [
      "has a bad time",
      Buffer.from(`1|yesterday|${POSITION.id}`).toString("base64url"),
    ],
    [
      "has a date that does not exist",
      Buffer.from(`1|2026-13-45T12:00:01.250Z|${POSITION.id}`).toString(
        "base64url",
      ),
    ],
    [
      "has a bad id",
      Buffer.from(`1|${POSITION.settledAt}|a b`).toString("base64url"),
    ],
    [
      "has another version",
      Buffer.from(`2|${POSITION.settledAt}|${POSITION.id}`).toString(
        "base64url",
      ),
    ],
    [
      "has a part too many",
      Buffer.from(`1|${POSITION.settledAt}|${POSITION.id}|x`).toString(
        "base64url",
      ),
    ],
    ["is not canonical base64url", nonCanonical()],
  ])("refuses a cursor that %s", (_name, text) => {
    expect(decodeUsageCursor(text)).toBeNull();
  });
});

describe("the safety lag", () => {
  // #278-T02
  it("is 60 seconds and a valid value", () => {
    expect(USAGE_SAFETY_LAG_MS).toBe(60_000);
    expect(validateSafetyLagMs(USAGE_SAFETY_LAG_MS)).toBe(USAGE_SAFETY_LAG_MS);
  });

  // #278-T02
  it.each([0, 999, -1, 1.5, Number.NaN, Infinity, 3_600_001])(
    "refuses %s",
    (value) => {
      expect(() => validateSafetyLagMs(value)).toThrow();
    },
  );
});
