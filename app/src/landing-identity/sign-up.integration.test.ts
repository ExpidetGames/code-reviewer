// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity at the sign-up with email and password (#692): the cookie the proxy set arrives with the POST,
// the account made after the answer carries the identity, and the answer says nothing about it. An address that has an
// account already is not touched, and nothing in the answer differs.
import { describe, expect, it } from "vitest";
import {
  SIGNUP_TEST_PASSWORD,
  createSignUpHarness,
} from "../test-support/signup-harness.ts";
import { LANDING_IDENTITY_COOKIE } from "./identity.ts";

const DID = "0192f5f0-7c3e-7a52-9d1b-3f6a2c4e8b10";
const SID = "0192f5f0-7c3e-7a52-9d1b-aaaaaaaaaaaa";
const ADDRESS = "newcomer@example.com";
const WITH_COOKIE = {
  cookie: `a=b; ${LANDING_IDENTITY_COOKIE}=${DID}~${SID}`,
};

describe("signing up with the landing identity", () => {
  // #692-T03
  it("stores the identity on the new user, and takes the cookie away in the answer", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp(
      { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
      WITH_COOKIE,
    );
    await harness.flush();

    expect(response.status).toBe(200);
    expect(await harness.user(ADDRESS)).toMatchObject({
      posthog_distinct_id: DID,
      posthog_session_id: SID,
    });
    expect((await harness.user(ADDRESS))?.posthog_captured_at).toMatch(
      /^2026-10-11T09:00:00/,
    );
    expect(
      response.headers
        .getSetCookie()
        .some((line) => line.startsWith(`${LANDING_IDENTITY_COOKIE}=;`)),
    ).toBe(true);
  });

  // #692-T06
  it.each([
    ["no cookie", {}],
    ["another cookie", { cookie: "a=b" }],
    ["an invalid identifier", { cookie: `${LANDING_IDENTITY_COOKIE}=a%20b~c` }],
    ["a malformed value", { cookie: `${LANDING_IDENTITY_COOKIE}=abc` }],
  ])(
    "stores nothing with %s, and the answer is the same",
    async (_label, headers) => {
      const harness = await createSignUpHarness({ mail: true });

      const response = await harness.signUp(
        { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
        headers,
      );
      await harness.flush();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, next: "verify_email" });
      expect(await harness.user(ADDRESS)).toMatchObject({
        posthog_distinct_id: null,
        posthog_session_id: null,
        posthog_captured_at: null,
      });
    },
  );

  // #692-T05
  it("does not touch an account that exists already, and the answer is the same", async () => {
    const harness = await createSignUpHarness({ mail: true });
    const first = await harness.signUp(
      { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
      {},
    );
    await harness.flush();

    const second = await harness.signUp(
      { email: ADDRESS, password: SIGNUP_TEST_PASSWORD },
      WITH_COOKIE,
    );
    await harness.flush();

    expect(await second.json()).toEqual(await first.json());
    expect(await harness.user(ADDRESS)).toMatchObject({
      posthog_distinct_id: null,
      posthog_captured_at: null,
    });
  });

  // #692-T06
  it("makes no account and stores nothing when the sign-up is refused", async () => {
    const harness = await createSignUpHarness({ mail: true });

    const response = await harness.signUp(
      { email: "not an address", password: SIGNUP_TEST_PASSWORD },
      WITH_COOKIE,
    );
    await harness.flush();

    expect(response.status).toBe(422);
    expect(await harness.counts()).toMatchObject({ users: 1 });
  });
});
