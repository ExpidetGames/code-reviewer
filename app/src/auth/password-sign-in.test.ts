// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the login form sorts what happens into four answers: the limit first, then only a
// 4xx answer of Better Auth means "wrong credentials"; a server problem is logged under its own
// code and shown as unavailable, never as a wrong password, and never with its reason.
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import {
  apiErrorStatus,
  signInWithPasswordChecked,
} from "./password-sign-in.ts";
import type { SignInLimiter } from "./sign-in-limit.ts";

function limiter(overrides: Partial<SignInLimiter> = {}): SignInLimiter {
  return {
    check: vi.fn(() => Promise.resolve({ allowed: true as const })),
    succeeded: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("recognizing an error of Better Auth", () => {
  it("reads the status of an APIError by its shape, also from another copy of the class", () => {
    class OtherCopyOfAPIError extends Error {
      statusCode = 401;
      constructor() {
        super("Invalid password");
        this.name = "APIError";
      }
    }

    expect(apiErrorStatus(new APIError("UNAUTHORIZED"))).toBe(401);
    expect(apiErrorStatus(new OtherCopyOfAPIError())).toBe(401);
  });

  it("knows nothing else as one", () => {
    expect(apiErrorStatus(new Error("database is locked"))).toBeNull();
    expect(apiErrorStatus({ statusCode: 401 })).toBeNull();
    expect(apiErrorStatus({ name: "APIError", statusCode: "401" })).toBeNull();
    expect(apiErrorStatus(null)).toBeNull();
    expect(apiErrorStatus("APIError")).toBeNull();
  });

  // #97-LIMIT
  it("sorts an error of another copy of the class like the original: wrong credentials, not a server error", async () => {
    class OtherCopyOfAPIError extends Error {
      statusCode = 401;
      constructor() {
        super("Invalid password");
        this.name = "APIError";
      }
    }
    const log = vi.fn();

    const outcome = await signInWithPasswordChecked(
      {
        limiter: limiter(),
        signIn: () => Promise.reject(new OtherCopyOfAPIError()),
        log,
      },
      "a@example.com",
      "pw",
    );

    expect(outcome).toEqual({ kind: "invalid_credentials" });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("signing in with a password", () => {
  it("signs in and forgets the failed attempts", async () => {
    const counter = limiter();
    const signIn = vi.fn(() => Promise.resolve({}));

    const outcome = await signInWithPasswordChecked(
      { limiter: counter, signIn },
      "a@example.com",
      "pw",
    );

    expect(outcome).toEqual({ kind: "ok" });
    expect(counter.succeeded).toHaveBeenCalledWith("a@example.com");
  });

  // #97-LIMIT
  it("refuses an attempt over the limit without asking Better Auth", async () => {
    const signIn = vi.fn();
    const counter = limiter({
      check: () => Promise.resolve({ allowed: false, retryAfterSeconds: 120 }),
    });

    const outcome = await signInWithPasswordChecked(
      { limiter: counter, signIn },
      "a@example.com",
      "pw",
    );

    expect(outcome).toEqual({ kind: "rate_limited", retryAfterSeconds: 120 });
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404])(
    "answers invalid_credentials for a %s of Better Auth and does not reset the counter",
    async (status) => {
      const counter = limiter();
      const outcome = await signInWithPasswordChecked(
        {
          limiter: counter,
          signIn: () =>
            Promise.reject(
              new APIError(
                status === 400
                  ? "BAD_REQUEST"
                  : status === 401
                    ? "UNAUTHORIZED"
                    : status === 403
                      ? "FORBIDDEN"
                      : "NOT_FOUND",
              ),
            ),
        },
        "a@example.com",
        "pw",
      );

      expect(outcome).toEqual({ kind: "invalid_credentials" });
      expect(counter.succeeded).not.toHaveBeenCalled();
    },
  );

  // #97-LIMIT
  it("logs a server problem under its own code, without the reason, and does not call it a wrong password", async () => {
    const log = vi.fn();
    const failures = [
      new Error("database is locked (secret detail)"),
      new APIError("INTERNAL_SERVER_ERROR"),
    ];

    for (const failure of failures) {
      const outcome = await signInWithPasswordChecked(
        { limiter: limiter(), signIn: () => Promise.reject(failure), log },
        "a@example.com",
        "pw",
      );

      expect(outcome).toEqual({ kind: "unavailable" });
    }
    expect(log).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) {
      expect(String(call[0])).toContain("SIGN_IN_SERVER_ERROR");
      expect(String(call[0])).not.toContain("secret detail");
    }
  });

  it("refuses when the attempts cannot be counted", async () => {
    const log = vi.fn();
    const signIn = vi.fn();

    const outcome = await signInWithPasswordChecked(
      {
        limiter: limiter({ check: () => Promise.reject(new Error("boom")) }),
        signIn,
        log,
      },
      "a@example.com",
      "pw",
    );

    expect(outcome).toEqual({ kind: "unavailable" });
    expect(signIn).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "SIGN_IN_LIMIT_UNAVAILABLE",
    );
  });
});
