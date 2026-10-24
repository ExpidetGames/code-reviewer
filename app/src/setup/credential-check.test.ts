// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the last check before the admin is created: the address and the password must be ones
// the sign in of Better Auth accepts, and the hash must verify. Anything else, including a verifier
// that throws, is "no": the setup then creates nothing.
import { describe, expect, it, vi } from "vitest";
import { createCredentialCheck } from "./credential-check.ts";

const GOOD = {
  email: "admin@example.com",
  password: "x7Kq-m2Vd9Lw",
  hash: "hash",
};

describe("the credential check", () => {
  // #97-EMAIL
  it("accepts an admin the sign in would accept", async () => {
    const verify = vi.fn(() => Promise.resolve(true));

    expect(await createCredentialCheck(verify)(GOOD)).toBe(true);
    expect(verify).toHaveBeenCalledWith({
      hash: "hash",
      password: GOOD.password,
    });
  });

  // #97-EMAIL
  it.each([
    "john..doe@example.com",
    "admin@corp.c",
    "o'brien@my_host.com",
    "nope",
  ])("refuses the address %s without asking the verifier", async (email) => {
    const verify = vi.fn(() => Promise.resolve(true));

    expect(await createCredentialCheck(verify)({ ...GOOD, email })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  // #97-PASSWORD-LENGTH
  it("refuses a password that is longer than 128 UTF-16 units, however few characters it has", async () => {
    const verify = vi.fn(() => Promise.resolve(true));
    const check = createCredentialCheck(verify);

    expect(await check({ ...GOOD, password: "🔑".repeat(70) })).toBe(false);
    expect(await check({ ...GOOD, password: "🔑🌲".repeat(32) })).toBe(true);
  });

  it("refuses when the hash does not verify, or the verifier throws", async () => {
    expect(
      await createCredentialCheck(() => Promise.resolve(false))(GOOD),
    ).toBe(false);
    expect(
      await createCredentialCheck(() => Promise.reject(new Error("boom")))(
        GOOD,
      ),
    ).toBe(false);
  });
});
