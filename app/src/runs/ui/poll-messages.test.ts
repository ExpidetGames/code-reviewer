// SPDX-License-Identifier: LicenseRef-Proprietary

// What the runs pages say when polling ends for good, including for a person who is no longer a member of the
// workspace (the shared polling stops on `not_found`, #282 review).
import { describe, expect, it } from "vitest";
import { describePollFailure, POLL_FAILED_TEXT } from "./poll-messages.ts";

describe("the sentence for a failed poll", () => {
  it("keeps the generic sentence while polling goes on", () => {
    expect(describePollFailure("not_found", false, POLL_FAILED_TEXT)).toBe(
      POLL_FAILED_TEXT,
    );
  });

  it("says that the page is not available to the person once polling stopped on not_found", () => {
    expect(describePollFailure("not_found", true, POLL_FAILED_TEXT)).toBe(
      "That is not available to you. This page no longer updates; reload it to try again.",
    );
  });
});
