// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity lives on the user row only, so it goes with the row (#692): the cleanup of a sign-up that never
// verified its address removes it. Nothing else holds a copy.
import { describe, expect, it } from "vitest";
import { cleanUpExpiredRows } from "../maintenance/cleanup.ts";
import {
  SIGNUP_TEST_PASSWORD,
  createSignUpHarness,
} from "../test-support/signup-harness.ts";
import { LANDING_IDENTITY_COOKIE } from "./identity.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("the landing identity of a user that is removed", () => {
  // #692-T08
  it("goes with the account of a sign-up that never verified its address", async () => {
    const harness = await createSignUpHarness({ mail: true });
    await harness.signUp(
      { email: "gone@example.com", password: SIGNUP_TEST_PASSWORD },
      { cookie: `${LANDING_IDENTITY_COOKIE}=did-1~sid-1` },
    );
    await harness.flush();
    expect((await harness.user("gone@example.com"))?.posthog_distinct_id).toBe(
      "did-1",
    );

    harness.advance(8 * DAY);
    const result = await cleanUpExpiredRows(harness.db, harness.now, {
      mailConfigured: () => true,
    });

    expect(result.unverifiedAccounts).toBe(1);
    expect(await harness.user("gone@example.com")).toBeUndefined();
    const left = await harness.db
      .selectFrom("users")
      .select(["posthog_distinct_id", "posthog_session_id"])
      .where((eb) =>
        eb.or([
          eb("posthog_distinct_id", "is not", null),
          eb("posthog_session_id", "is not", null),
        ]),
      )
      .execute();
    expect(left).toEqual([]);
  });
});
