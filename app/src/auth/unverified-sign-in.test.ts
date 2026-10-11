// SPDX-License-Identifier: Apache-2.0

// Pins down when an email and password sign in is refused for an unverified address: only after the
// password was right, never for the instance admin, never for a verified account, and only while the
// instance can send mail.
import { describe, expect, it, vi } from "vitest";
import {
  judgeUnverifiedSignIn,
  type UnverifiedSignInDependencies,
} from "./unverified-sign-in.ts";

function dependencies(
  user: Awaited<ReturnType<UnverifiedSignInDependencies["findUser"]>>,
  options: { required?: boolean; passwordRight?: boolean } = {},
) {
  const verificationRequired = vi.fn(() =>
    Promise.resolve(options.required ?? true),
  );
  const verifyPassword = vi.fn(() =>
    Promise.resolve(options.passwordRight ?? true),
  );
  const findUser = vi.fn(() => Promise.resolve(user));
  return { findUser, verifyPassword, verificationRequired };
}

const UNVERIFIED = {
  emailVerified: false,
  isInstanceAdmin: false,
  passwordHash: "hash",
};

describe("refusing an unverified email and password sign in", () => {
  // #99-SR-10
  it("refuses an unverified account whose password is right while the instance can send mail", async () => {
    expect(
      await judgeUnverifiedSignIn(dependencies(UNVERIFIED), "A@B.com", "pw"),
    ).toBe("not_verified");
  });

  // #99-SR-14
  it("answers a wrong password as a wrong password, after exactly one check of it", async () => {
    const deps = dependencies(UNVERIFIED, { passwordRight: false });

    expect(await judgeUnverifiedSignIn(deps, "a@b.com", "wrong")).toBe(
      "wrong_password",
    );
    expect(deps.verifyPassword).toHaveBeenCalledTimes(1);
  });

  // #99-SR-14
  it("leaves an address nobody has, or an account without a password", async () => {
    expect(
      await judgeUnverifiedSignIn(dependencies(null), "a@b.com", "pw"),
    ).toBe("go_on");
    expect(
      await judgeUnverifiedSignIn(
        dependencies({ ...UNVERIFIED, passwordHash: null }),
        "a@b.com",
        "pw",
      ),
    ).toBe("go_on");
  });

  // #99-SR-24
  it("never refuses the instance admin", async () => {
    const deps = dependencies({ ...UNVERIFIED, isInstanceAdmin: true });

    expect(await judgeUnverifiedSignIn(deps, "a@b.com", "pw")).toBe("go_on");
    expect(deps.verifyPassword).not.toHaveBeenCalled();
  });

  it("does not refuse a verified account, and does not even hash the password", async () => {
    const deps = dependencies({ ...UNVERIFIED, emailVerified: true });

    expect(await judgeUnverifiedSignIn(deps, "a@b.com", "pw")).toBe("go_on");
    expect(deps.verifyPassword).not.toHaveBeenCalled();
    expect(deps.verificationRequired).not.toHaveBeenCalled();
  });

  // #99-SR-08
  it("does not refuse when the instance cannot send mail", async () => {
    const deps = dependencies(UNVERIFIED, { required: false });

    expect(await judgeUnverifiedSignIn(deps, "a@b.com", "pw")).toBe("go_on");
    expect(deps.verifyPassword).not.toHaveBeenCalled();
  });

  it("looks the address up in lower case, like Better Auth", async () => {
    const deps = dependencies(UNVERIFIED);

    await judgeUnverifiedSignIn(deps, "MiXed@Example.COM", "pw");

    expect(deps.findUser).toHaveBeenCalledWith("mixed@example.com");
  });
});
