// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the password rule: the length bounds, the common password list, and that the refusal
// carries a stable code (the form translates it to a sentence).
import { describe, expect, it } from "vitest";
import {
  checkPassword,
  PASSWORD_ERROR_CODES,
  PASSWORD_ERROR_COPY,
} from "./password-policy.ts";

describe("checkPassword", () => {
  // #97-SU-10
  it("refuses 11 characters with password_too_short", () => {
    expect(checkPassword("x7Kq-m2Vd9L")).toEqual({
      ok: false,
      code: "password_too_short",
    });
  });

  // #97-SU-10
  it("accepts exactly 12 uncommon characters", () => {
    expect(checkPassword("x7Kq-m2Vd9Lw")).toEqual({ ok: true });
  });

  // #97-PASSWORD-LENGTH
  it("refuses a password of astral characters that is longer than 128 UTF-16 units, which Better Auth would refuse on sign in", () => {
    const astral = "🔑".repeat(70);

    expect(Array.from(astral)).toHaveLength(70);
    expect(astral.length).toBe(140);
    expect(checkPassword(astral)).toEqual({
      ok: false,
      code: "password_too_long",
    });
    expect(checkPassword("🔑🌲".repeat(32))).toEqual({ ok: true });
  });

  // #97-SU-10
  it("refuses 129 characters with password_too_long and accepts 128", () => {
    expect(checkPassword("k".repeat(64) + "m".repeat(65))).toEqual({
      ok: false,
      code: "password_too_long",
    });
    expect(checkPassword("k".repeat(64) + "m".repeat(64))).toEqual({
      ok: true,
    });
  });

  // #97-SU-10
  it("refuses password1234 as a common password", () => {
    expect(checkPassword("password1234")).toEqual({
      ok: false,
      code: "password_too_common",
    });
  });

  // #97-SU-10
  it("accepts 12 unicode characters and counts them as characters, not bytes", () => {
    expect(checkPassword("Ünïcödé-Pässwörd".slice(0, 12))).toEqual({
      ok: true,
    });
    expect(checkPassword("🔑🌲🚀🎲🌊🔥🍀🎯🧩🪐🌙⚡")).toEqual({ ok: true });
    expect(checkPassword("🔑🌲🚀🎲🌊🔥🍀🎯🧩🪐🌙")).toEqual({
      ok: false,
      code: "password_too_short",
    });
  });

  it("refuses a common password whatever its case or width", () => {
    expect(checkPassword("PASSWORD1234").ok).toBe(false);
    expect(checkPassword("ｐａｓｓｗｏｒｄ１２３４").ok).toBe(false);
  });

  it("refuses a well-known word with only digits or symbols behind it", () => {
    for (const password of [
      "password2024!!",
      "welcome-2031-99",
      "Qwerty987654321",
    ])
      expect(checkPassword(password)).toEqual({
        ok: false,
        code: "password_too_common",
      });
  });

  it("refuses one character repeated", () => {
    expect(checkPassword("a".repeat(20))).toEqual({
      ok: false,
      code: "password_too_common",
    });
  });

  it("does not refuse a long passphrase just because it contains a common word", () => {
    expect(checkPassword("password-horse-staple-orbit")).toEqual({ ok: true });
  });

  it("has a sentence for every refusal code", () => {
    for (const code of PASSWORD_ERROR_CODES)
      expect(PASSWORD_ERROR_COPY[code].length).toBeGreaterThan(10);
  });
});
