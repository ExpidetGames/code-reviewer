// Pins down "has the GitHub App been started to configure": any one variable with a value, white
// space does not count, and none at all is the normal state of an instance that is not connected.
import { describe, expect, it } from "vitest";
import { anyGithubAppVariableSet, GITHUB_APP_VARIABLES } from "./configured.ts";

describe("anyGithubAppVariableSet", () => {
  it("is false without any GitHub App variable, and for blank ones", () => {
    expect(anyGithubAppVariableSet({})).toBe(false);
    expect(
      anyGithubAppVariableSet({ GITHUB_APP_ID: "", GITHUB_APP_SLUG: "  " }),
    ).toBe(false);
    expect(anyGithubAppVariableSet({ GITHUB_OAUTH_CLIENT_ID: "x" })).toBe(
      false,
    );
  });

  it.each(GITHUB_APP_VARIABLES)("is true when %s has a value", (name) => {
    expect(anyGithubAppVariableSet({ [name]: "value" })).toBe(true);
  });
});
