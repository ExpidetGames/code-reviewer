// SPDX-License-Identifier: LicenseRef-Proprietary

// The setup must never accept an admin email address that the sign in then refuses: the instance
// would be set up for good (the setup answers 404 afterwards) with an admin who cannot sign in.
// Property style: a large, seeded set of addresses with all the odd parts people and tools produce
// (double dots, quotes, underscores in host names, one letter top level domains, plus tags, unicode),
// and for every address the setup accepts, the real Better Auth sign in must get as far as looking at
// the credentials, not stop at "invalid email".
import { describe, expect, it } from "vitest";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
} from "../test-support/setup-harness.ts";
import { isValidEmail, normalizeEmail } from "./input.ts";

// A small deterministic generator, so a failure can be reproduced.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const LOCALS = [
  "john",
  "doe",
  "j.doe",
  "john..doe",
  ".john",
  "john.",
  "o'brien",
  "a+tag",
  "a_b",
  "a-b",
  '"quoted"',
  "ünï",
  "x",
  "very.long.local.part.with.many.dots",
  "a@b",
  "a b",
  "a!#$%&*/=?^`{|}~b",
];
const HOSTS = [
  "example.com",
  "corp.c",
  "my_host.com",
  "a-b.example.org",
  "-bad.com",
  "bad-.com",
  "sub.example.co.uk",
  "xn--bcher-kva.example",
  "例え.jp",
  "localhost",
  "1.2.3.4",
  "[1.2.3.4]",
  "example..com",
  "example.123",
  "a.b",
  "host.technology",
];

function corpus(): string[] {
  const next = random(97);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)] as T;
  const addresses = new Set<string>();
  for (const local of LOCALS)
    for (const host of HOSTS) addresses.add(`${local}@${host}`);
  for (let index = 0; index < 400; index += 1)
    addresses.add(
      `${pick(LOCALS)}${pick(["", ".", "-", "_"])}${pick(LOCALS)}@${pick(HOSTS)}`,
    );
  return [...addresses].map(normalizeEmail);
}

describe("the email addresses the setup accepts", () => {
  // #97-EMAIL
  it("are all addresses that the sign in of Better Auth takes as valid", async () => {
    const harness = await createSetupHarness();
    const accepted = corpus().filter(isValidEmail);
    expect(accepted.length).toBeGreaterThan(30);

    const refusedBySignIn: string[] = [];
    for (const email of accepted) {
      const outcome = await harness.auth.api
        .signInEmail({ body: { email, password: SETUP_TEST_ADMIN.password } })
        .then(
          () => "signed in",
          (error: unknown) =>
            (error as { body?: { code?: string } }).body?.code,
        );
      if (outcome === "INVALID_EMAIL") refusedBySignIn.push(email);
    }

    expect(refusedBySignIn).toEqual([]);
  });

  // #97-EMAIL
  it("do not include the examples that locked an admin out", () => {
    for (const email of [
      "john..doe@example.com",
      "admin@corp.c",
      "o'brien@my_host.com",
    ])
      expect(isValidEmail(email)).toBe(false);
    expect(isValidEmail("john.doe@example.com")).toBe(true);
  });
});
