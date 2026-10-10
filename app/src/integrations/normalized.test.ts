// Pins down the runtime guards for the normalized types. They are what keeps a raw platform payload
// from travelling through the app disguised as a RepoRef, ReviewTrigger or GitAccess.
import { describe, expect, it } from "vitest";
import { isGitAccess, isRepoRef, isReviewTrigger } from "./normalized.ts";
import type { GitAccess, RepoRef, ReviewTrigger } from "./types.ts";

const repo: RepoRef = {
  integrationId: "int-1",
  externalId: "42",
  fullName: "acme/widgets",
  url: "https://example.test/acme/widgets",
};

const opened: ReviewTrigger = {
  kind: "opened",
  repo,
  prNumber: 7,
  headSha: "abc123",
  command: null,
  args: null,
  actor: { login: "alice", externalId: "1" },
};

const access: GitAccess = {
  provider: "github",
  baseUrl: "https://api.example.test",
  token: "dummy-token",
  authType: "token",
  botLogin: "reviewer[bot]",
  expiresAt: "2026-10-10T13:00:00.000Z",
};

describe("the normalized type guards", () => {
  it("accepts a well formed repo reference", () => {
    expect(isRepoRef(repo)).toBe(true);
  });

  it("rejects a repo reference with a missing field, a wrong type or an extra platform field", () => {
    expect(isRepoRef({ ...repo, fullName: undefined })).toBe(false);
    expect(isRepoRef({ ...repo, externalId: 42 })).toBe(false);
    expect(isRepoRef({ ...repo, node_id: "MDEwOlJlcG9zaXRvcnkx" })).toBe(false);
    expect(isRepoRef(null)).toBe(false);
  });

  it("accepts opened, updated and command triggers", () => {
    expect(isReviewTrigger(opened)).toBe(true);
    expect(isReviewTrigger({ ...opened, kind: "updated" })).toBe(true);
    expect(
      isReviewTrigger({
        ...opened,
        kind: "command",
        command: "ask",
        args: "why?",
      }),
    ).toBe(true);
  });

  it("rejects a trigger whose kind and command do not fit together", () => {
    expect(isReviewTrigger({ ...opened, command: "review", args: "" })).toBe(
      false,
    );
    expect(isReviewTrigger({ ...opened, kind: "command" })).toBe(false);
    expect(
      isReviewTrigger({
        ...opened,
        kind: "command",
        command: "deploy",
        args: "",
      }),
    ).toBe(false);
    expect(isReviewTrigger({ ...opened, kind: "labeled" })).toBe(false);
  });

  it("rejects a trigger with a bad pull request number, a nested raw payload or an extra field", () => {
    expect(isReviewTrigger({ ...opened, prNumber: 0 })).toBe(false);
    expect(isReviewTrigger({ ...opened, prNumber: 1.5 })).toBe(false);
    expect(isReviewTrigger({ ...opened, repo: { ...repo, owner: {} } })).toBe(
      false,
    );
    expect(isReviewTrigger({ ...opened, payload: { action: "opened" } })).toBe(
      false,
    );
  });

  it("accepts git access with and without a bot login or an expiry", () => {
    expect(isGitAccess(access)).toBe(true);
    expect(isGitAccess({ ...access, botLogin: null, expiresAt: null })).toBe(
      true,
    );
  });

  it("rejects git access with an unknown platform or auth type, an empty token or an extra field", () => {
    expect(isGitAccess({ ...access, provider: "svn" })).toBe(false);
    expect(isGitAccess({ ...access, authType: "basic" })).toBe(false);
    expect(isGitAccess({ ...access, token: "" })).toBe(false);
    expect(isGitAccess({ ...access, installationId: 9 })).toBe(false);
  });
});
