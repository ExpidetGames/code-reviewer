// Pins down that every stable code a project action can fail with has copy a person can act on, and
// that an unknown code still gets a sentence instead of the raw code.
import { describe, expect, it } from "vitest";
import { SYNC_ERROR_CODES } from "../../integrations/sync/errors.ts";
import { TRANSPORT_ERROR_CODES } from "../../ui/json-request.ts";
import { PROJECT_ERROR_CODES } from "../errors.ts";
import { describeFailure, describeSyncProblem } from "./messages.ts";

describe("the copy for a failed project action", () => {
  // CR-34-T04
  it.each([
    ...PROJECT_ERROR_CODES,
    ...SYNC_ERROR_CODES,
    ...TRANSPORT_ERROR_CODES,
  ])("has a sentence for %s that is not the code itself", (code) => {
    const text = describeFailure(code);

    expect(text).not.toBe("");
    expect(text).not.toContain(code);
  });

  it("explains a repository that is no longer available", () => {
    expect(describeFailure("PROJECT_REPOSITORY_UNAVAILABLE")).toMatch(
      /no longer available/i,
    );
  });

  it("falls back to a generic sentence for a code it does not know", () => {
    expect(describeFailure("SOMETHING_NEW")).toBe(
      "Something went wrong. Reload the page and try again.",
    );
  });
});

describe("the copy for a problem the sync met at GitHub", () => {
  // The provider's own list cannot be imported here (the boundary); these are its codes.
  it.each([
    "GITHUB_APP_CONFIG_INVALID",
    "GITHUB_APP_AUTH_FAILED",
    "GITHUB_APP_FORBIDDEN",
    "GITHUB_APP_NOT_FOUND",
    "GITHUB_APP_RATE_LIMITED",
    "GITHUB_APP_UNAVAILABLE",
    "GITHUB_APP_REQUEST_FAILED",
  ])("has a sentence for %s", (code) => {
    const text = describeSyncProblem(code);

    expect(text).not.toBe("");
    expect(text).not.toContain(code);
  });

  it("falls back to a generic sentence for a code it does not know", () => {
    expect(describeSyncProblem("SOMETHING_NEW")).toMatch(/GitHub/);
  });
});
