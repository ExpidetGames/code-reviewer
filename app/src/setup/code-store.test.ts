// SPDX-License-Identifier: Apache-2.0

// Pins down the setup code store with a fake clock: expiry after 60 minutes, about five attempts per
// minute for the whole process, the lock after ten wrong attempts until a new code is issued, and
// single use. The store never writes anywhere, so there is nothing to leak but its return values.
import { describe, expect, it } from "vitest";
import {
  createSetupCodeStore,
  SETUP_ATTEMPT_WINDOW_MS,
  SETUP_CODE_TTL_MS,
} from "./code-store.ts";

function fixture(options: { code?: string } = {}) {
  let time = 1_000_000;
  const store = createSetupCodeStore({
    now: () => time,
    ...(options.code === undefined ? {} : { randomCode: () => options.code! }),
  });
  return {
    store,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("the setup code", () => {
  it("is six digits from the secure random source", () => {
    const { store } = fixture();

    const codes = new Set(Array.from({ length: 20 }, () => store.issue()));

    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(1);
  });

  it("refuses everything until a code was issued", () => {
    const { store } = fixture();

    expect(store.attempt("123456")).toEqual({
      ok: false,
      error: "setup_unavailable",
    });
    expect(store.currentIssueId()).toBeNull();
  });

  // #97-SU-04
  it("refuses a wrong code and says nothing about how close it was", () => {
    const { store } = fixture({ code: "482913" });
    store.issue();

    const result = store.attempt("482914");

    expect(result).toEqual({ ok: false, error: "invalid_code" });
    expect(JSON.stringify(result)).not.toMatch(/\d{6}|4829|2913/);
  });

  // #97-SU-05
  it("accepts the correct code once and ties it to the issuance", () => {
    const { store } = fixture({ code: "482913" });
    store.issue();

    const result = store.attempt("482913");

    expect(result).toEqual({ ok: true, issueId: store.currentIssueId() });
  });

  it("accepts the code with whitespace around it", () => {
    const { store } = fixture({ code: "000042" });
    store.issue();

    expect(store.attempt("  000042\n").ok).toBe(true);
  });

  // #97-SU-06
  it("refuses a code that was used already, whoever sends it", () => {
    const { store } = fixture({ code: "482913" });
    store.issue();
    store.attempt("482913");

    expect(store.attempt("482913")).toEqual({
      ok: false,
      error: "code_used",
    });
  });

  it.each([undefined, null, 482913, {}, [], "", "12345", "1234567", "abcdef"])(
    "counts the submission %j as a wrong code",
    (submitted) => {
      const { store } = fixture({ code: "482913" });
      store.issue();

      expect(store.attempt(submitted)).toEqual({
        ok: false,
        error: "invalid_code",
      });
    },
  );

  // #97-SU-07
  it("refuses the sixth attempt within a minute with the time to wait, and accepts it after the window", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(store.attempt("000000")).toEqual({
        ok: false,
        error: "invalid_code",
      });
      advance(1_000);
    }

    const refused = store.attempt("482913");

    expect(refused).toMatchObject({ ok: false, error: "rate_limited" });
    expect(
      refused.ok === false ? refused.retryAfterSeconds : undefined,
    ).toBeGreaterThan(0);
    expect(
      refused.ok === false ? refused.retryAfterSeconds : undefined,
    ).toBeLessThanOrEqual(60);

    advance(SETUP_ATTEMPT_WINDOW_MS);

    expect(store.attempt("482913").ok).toBe(true);
  });

  it("does not count a rate limited attempt as a wrong code", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    for (let attempt = 0; attempt < 5; attempt += 1) store.attempt("000000");
    for (let attempt = 0; attempt < 20; attempt += 1)
      expect(store.attempt("000000")).toMatchObject({ error: "rate_limited" });
    advance(SETUP_ATTEMPT_WINDOW_MS);

    // Only the five counted failures so far: this one is the sixth, not locked.
    expect(store.attempt("000000")).toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  // #97-SU-08
  it("locks after ten wrong attempts, refuses even the correct code, and a new code unlocks it", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      store.attempt("000000");
      advance(SETUP_ATTEMPT_WINDOW_MS);
    }

    expect(store.attempt("482913")).toEqual({
      ok: false,
      error: "setup_locked",
    });
    advance(SETUP_CODE_TTL_MS / 4);
    expect(store.attempt("482913")).toEqual({
      ok: false,
      error: "setup_locked",
    });

    store.issue();

    expect(store.attempt("482913").ok).toBe(true);
  });

  it("does not lock after nine wrong attempts", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      store.attempt("000000");
      advance(SETUP_ATTEMPT_WINDOW_MS);
    }

    expect(store.attempt("482913").ok).toBe(true);
  });

  // #97-SU-21
  it("refuses a code that is 61 minutes old as expired, and a new code works", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    advance(61 * 60 * 1000);

    expect(store.attempt("482913")).toEqual({
      ok: false,
      error: "code_expired",
    });

    store.issue();

    expect(store.attempt("482913").ok).toBe(true);
  });

  it("accepts a code that is 59 minutes old", () => {
    const { store, advance } = fixture({ code: "482913" });
    store.issue();
    advance(59 * 60 * 1000);

    expect(store.attempt("482913").ok).toBe(true);
  });

  // #97-SU-02
  it("refuses the code of an earlier issuance after a new one was issued, and gives it a new id", () => {
    const { store } = fixture();
    const first = store.issue();
    const firstId = store.currentIssueId();
    let second = store.issue();
    while (second === first) second = store.issue();

    expect(store.currentIssueId()).not.toBe(firstId);
    expect(store.attempt(first)).toEqual({ ok: false, error: "invalid_code" });
    expect(store.attempt(second).ok).toBe(true);
  });

  it("refuses every code after the setup was completed", () => {
    const { store } = fixture({ code: "482913" });
    store.issue();

    store.invalidate();

    expect(store.attempt("482913")).toMatchObject({ ok: false });
    expect(store.attempt("482913").ok).toBe(false);
  });
});
