// SPDX-License-Identifier: Apache-2.0

// Pins down that the sentences the project list shows for a problem the sync met at GitHub cover every
// error code of the GitHub App provider. The UI may not import the provider, so it spells the codes
// out (src/projects/ui/messages.ts); this test sits in the provider folder, where importing both is
// allowed, and fails when a provider code is added or removed without the copy following.
import { describe, expect, it } from "vitest";
import { SYNC_PROBLEM_CODES } from "../../../projects/ui/messages.ts";
import { GITHUB_APP_ERROR_CODES } from "./errors.ts";

describe("the copy for problems the sync reports", () => {
  it("covers exactly the error codes of the GitHub App provider", () => {
    expect([...SYNC_PROBLEM_CODES].sort()).toEqual(
      [...GITHUB_APP_ERROR_CODES].sort(),
    );
  });
});
