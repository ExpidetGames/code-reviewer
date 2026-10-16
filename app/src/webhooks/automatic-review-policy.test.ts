// SPDX-License-Identifier: Apache-2.0

// The trigger policy for automatic reviews is a pure function: which pull request events start a
// review, which wait, which are dropped. No database, no GitHub.
import { describe, expect, it } from "vitest";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import type { ReviewTrigger } from "../integrations/types.ts";
import {
  checkAgainstCurrentPullRequest,
  decideAutomaticTrigger,
  type PullRequestTrigger,
} from "./automatic-review-policy.ts";

const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

function trigger(
  overrides: Partial<PullRequestTrigger> = {},
): PullRequestTrigger {
  return {
    kind: "opened",
    repo: {
      integrationId: "integration-1",
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: HEAD,
    command: null,
    args: null,
    actor: { login: "alice", externalId: "1001" },
    draft: false,
    state: "open",
    ...overrides,
  };
}

const settings = builtInReviewSettings("some/model");

function decide(
  t: PullRequestTrigger,
  overrides: Partial<Parameters<typeof decideAutomaticTrigger>[0]> = {},
) {
  return decideAutomaticTrigger({
    trigger: t,
    settings,
    ...overrides,
  });
}

describe("which pull request triggers create a job", () => {
  // CR-31-T02
  it.each(["opened", "updated"] as const)(
    "creates a job for the %s trigger of an open pull request that is no draft",
    (kind) => {
      expect(decide(trigger({ kind }))).toMatchObject({ action: "enqueue" });
    },
  );

  // CR-31-T04
  it.each(["opened", "updated"] as const)(
    "creates no job for the %s trigger of a draft",
    (kind) => {
      expect(decide(trigger({ kind, draft: true }))).toEqual({
        action: "skip",
        reason: "draft",
      });
    },
  );

  // CR-31-T09
  it.each(["opened", "updated"] as const)(
    "creates no job for the %s trigger of a pull request that is closed",
    (kind) => {
      expect(decide(trigger({ kind, state: "closed" }))).toEqual({
        action: "skip",
        reason: "pull_request_closed",
      });
    },
  );

  it("says closed for a closed draft, because a closed pull request is over whatever it was", () => {
    expect(decide(trigger({ draft: true, state: "closed" }))).toEqual({
      action: "skip",
      reason: "pull_request_closed",
    });
  });
});

describe("the settings that switch automatic reviews off", () => {
  // CR-31-T11
  it("creates no job for an opened pull request when reviews on open are off", () => {
    expect(
      decide(trigger({ kind: "opened" }), {
        settings: { ...settings, autoReviewOnOpen: false },
      }),
    ).toEqual({ action: "skip", reason: "automatic_review_disabled" });
  });

  it("still reviews a push when only reviews on open are off", () => {
    expect(
      decide(trigger({ kind: "updated" }), {
        settings: { ...settings, autoReviewOnOpen: false },
      }),
    ).toMatchObject({ action: "enqueue" });
  });

  it("creates no job for a push when reviews on push are off, and still reviews an opened pull request", () => {
    const pushOff = { ...settings, autoReviewOnPush: false };

    expect(decide(trigger({ kind: "updated" }), { settings: pushOff })).toEqual(
      {
        action: "skip",
        reason: "automatic_review_disabled",
      },
    );
    expect(
      decide(trigger({ kind: "opened" }), { settings: pushOff }),
    ).toMatchObject({ action: "enqueue" });
  });

  it("says draft before disabled, so a draft is skipped for the reason the author can fix", () => {
    expect(
      decide(trigger({ draft: true }), {
        settings: { ...settings, autoReviewOnOpen: false },
      }),
    ).toEqual({ action: "skip", reason: "draft" });
  });
});

describe("when the job is due", () => {
  // #395-T03
  it("makes no trigger wait: a push is due at once, like an opened pull request", () => {
    for (const kind of ["updated", "opened"] as const)
      expect(decide(trigger({ kind }))).toEqual({ action: "enqueue" });
  });
});

describe("a trigger compared with the pull request as it is now", () => {
  const current = {
    number: 7,
    title: "Add widgets",
    url: "https://github.test/acme/widgets/pull/7",
    headSha: HEAD,
    baseRef: "main",
    headRef: "feature",
    draft: false,
    state: "open" as const,
    author: { login: "alice", externalId: "1001" },
  };

  it("keeps a trigger whose head commit is still the head", () => {
    expect(checkAgainstCurrentPullRequest(trigger(), current)).toBeNull();
  });

  it("compares the commits without regard to case", () => {
    expect(
      checkAgainstCurrentPullRequest(trigger(), {
        ...current,
        headSha: HEAD.toUpperCase(),
      }),
    ).toBeNull();
  });

  // CR-31-T06 (out of order deliveries)
  it("drops a trigger for a commit that is not the head any more", () => {
    expect(
      checkAgainstCurrentPullRequest(trigger({ kind: "updated" }), {
        ...current,
        headSha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
      }),
    ).toEqual({ action: "skip", reason: "stale_head" });
  });

  // CR-31-T09
  it.each(["closed", "merged"] as const)(
    "drops a trigger for a pull request that is %s by now",
    (state) => {
      expect(
        checkAgainstCurrentPullRequest(trigger(), { ...current, state }),
      ).toEqual({ action: "skip", reason: "pull_request_closed" });
    },
  );

  it("drops a trigger for a pull request that was turned into a draft in the meantime", () => {
    expect(
      checkAgainstCurrentPullRequest(trigger(), { ...current, draft: true }),
    ).toEqual({ action: "skip", reason: "draft" });
  });
});

// Compile time check: the policy only ever sees pull request triggers, never command triggers.
const _commandIsNotAPullRequestTrigger: ReviewTrigger extends PullRequestTrigger
  ? never
  : true = true;
void _commandIsNotAPullRequestTrigger;
