// SPDX-License-Identifier: Apache-2.0

// Pins down the copy of the manual start: every code of the module has a sentence of its own that
// never shows the code, and an unknown code gets the generic sentence.
import { describe, expect, it } from "vitest";
import { MANUAL_REVIEW_ERROR_CODES } from "../errors.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import { describeManualReviewFailure, staleListFailure } from "./messages.ts";

describe("the copy for failures of the manual start", () => {
  it.each(MANUAL_REVIEW_ERROR_CODES)(
    "has a sentence of its own for %s that does not show the code",
    (code) => {
      const text = describeManualReviewFailure(code);

      expect(text).not.toBe(GENERIC_FAILURE);
      expect(text).not.toContain("MANUAL_REVIEW");
      expect(text.endsWith(".")).toBe(true);
    },
  );

  it("tells the transport failures in plain words", () => {
    expect(describeManualReviewFailure("NETWORK_ERROR")).toContain(
      "could not be reached",
    );
  });

  it("answers a code it does not know with the generic sentence", () => {
    expect(describeManualReviewFailure("SOMETHING_NEW")).toBe(GENERIC_FAILURE);
    expect(describeManualReviewFailure("toString")).toBe(GENERIC_FAILURE);
  });

  it("reloads the list after a pull request that is gone or closed, and only then", () => {
    expect(staleListFailure("MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN")).toBe(true);
    expect(staleListFailure("MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND")).toBe(true);
    expect(staleListFailure("MANUAL_REVIEW_GITHUB_UNAVAILABLE")).toBe(false);
  });
});
