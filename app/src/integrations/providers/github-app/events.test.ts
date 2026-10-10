// Pins down which pull request actions start a review: opened, reopened, ready for review and new
// commits do, everything else does not. A draft pull request is translated like any other, because
// whether drafts are skipped is decided by the automatic triggers ticket (CR-31), not here.
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../../../fakes/github/webhooks.ts";
import { parseGithubEvent } from "./events.ts";

async function eventOf(fixture: string) {
  return parseGithubEvent({
    integrationId: "integration-1",
    eventName: fixture.split(".")[0] as string,
    payload: webhookFixture(fixture),
    hasWriteAccess: async () => {
      throw new Error("a pull request delivery must not ask for permissions");
    },
    headShaOf: async () => {
      throw new Error("a pull request delivery carries its head commit");
    },
  });
}

describe("which pull request actions start a review", () => {
  // CR-22-T09
  it.each([
    ["pull_request.opened", "opened"],
    ["pull_request.synchronize", "updated"],
    ["pull_request.reopened", "opened"],
    ["pull_request.ready_for_review", "opened"],
  ])("%s becomes a %s trigger", async (fixture, kind) => {
    expect(await eventOf(fixture)).toMatchObject({
      kind: "review_trigger",
      trigger: { kind },
    });
  });

  // CR-22-T09
  it.each([
    "pull_request.closed",
    "pull_request.edited",
    "pull_request.labeled",
    "pull_request.converted_to_draft",
  ])("%s becomes no trigger", async (fixture) => {
    expect(await eventOf(fixture)).toMatchObject({ kind: "ignored" });
  });

  // CR-22-T09: the Jira case expects no trigger for a draft; the project lead moved that decision
  // to CR-31 (drafts are skipped until they are ready), so the translation passes it on.
  it("translates a pull request opened as a draft like any other", async () => {
    expect(await eventOf("pull_request.opened.draft")).toMatchObject({
      kind: "review_trigger",
      trigger: { kind: "opened", prNumber: 7 },
    });
  });
});
