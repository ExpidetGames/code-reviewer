// Pins down the portable column conventions: JSON as text, booleans as integers 0 and 1, and
// timestamps as ISO 8601 text in UTC. These helpers are the only place that knows the encodings.
import { describe, expect, it } from "vitest";
import {
  decodeBoolean,
  decodeJson,
  tryDecodeJson,
  encodeBoolean,
  encodeJson,
  formatTimestamp,
} from "./codecs.ts";

describe("JSON columns", () => {
  it("round-trips a nested object through text", () => {
    const value = { a: [1, { b: null }], c: "text" };

    const stored = encodeJson(value);

    expect(typeof stored).toBe("string");
    expect(decodeJson(stored)).toEqual(value);
  });

  it.each([undefined, () => 1, Symbol("x")])(
    "refuses a value JSON cannot represent (%s)",
    (value) => {
      expect(() => encodeJson(value)).toThrow(/cannot be stored as JSON/);
    },
  );

  it("stores null as the text null", () => {
    expect(encodeJson(null)).toBe("null");
  });

  it("refuses text that is not valid JSON", () => {
    expect(() => decodeJson("{nope")).toThrow(/JSON/);
  });
});

describe("boolean columns", () => {
  it("stores true as 1 and false as 0", () => {
    expect(encodeBoolean(true)).toBe(1);
    expect(encodeBoolean(false)).toBe(0);
  });

  it("reads 1 and 0 back as booleans", () => {
    expect(decodeBoolean(1)).toBe(true);
    expect(decodeBoolean(0)).toBe(false);
  });

  it("refuses any other stored number", () => {
    expect(() => decodeBoolean(2)).toThrow(/boolean/);
  });
});

describe("timestamp columns", () => {
  it("formats a date as ISO 8601 text in UTC with milliseconds", () => {
    const date = new Date(Date.UTC(2026, 9, 10, 12, 30, 15, 42));

    expect(formatTimestamp(date)).toBe("2026-10-10T12:30:15.042Z");
  });
});

describe("reading JSON that may be damaged", () => {
  it("returns the value of valid text and ok: false for text that is not JSON", () => {
    expect(tryDecodeJson<{ a: number }>('{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(tryDecodeJson("null")).toEqual({ ok: true, value: null });
    for (const text of ["{nope", "", "undefined", '{"a":'])
      expect(tryDecodeJson(text)).toEqual({ ok: false });
  });
});
