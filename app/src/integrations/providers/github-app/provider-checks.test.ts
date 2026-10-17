// SPDX-License-Identifier: Apache-2.0

// The check run and the review verdict of the GitHub App provider with an in-memory client (#405): which scopes
// the provider asks for (the checks permission and the pull request permission, never both in one token), that an
// existing check run is updated and a missing one created, that an earlier call that may have worked is looked
// for first, and that every failure leaves as a provider neutral code.
import { describe, expect, it } from "vitest";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import type { Integration, RepoRef, ReviewCheck } from "../../types.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { createGithubAppProvider } from "./provider.ts";

const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const integration: Integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});
const widgets: RepoRef = {
  integrationId: "integration-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};
const CHECK: ReviewCheck = {
  jobId: "job-1",
  headSha: HEAD,
  name: "Code Reviewer",
  status: "queued",
  title: "Waiting",
  summary: "A review is waiting.",
};

function setup(data: FakeGithubAppClientData = {}) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client,
  });
  return { client, provider };
}

async function failureOf(run: Promise<unknown> | undefined) {
  return run?.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe("publishing the check run of a review", () => {
  // #405-T01
  it("creates the check run with a token limited to the repository and the checks permission", async () => {
    const { client, provider } = setup();

    const published = await provider.publishReviewCheck?.(
      integration,
      widgets,
      CHECK,
      { checkRunId: null, mayExist: false },
    );

    expect(published).toEqual({ checkRunId: "9001" });
    expect(
      client.calls.filter((call) => call.method === "createCheckRun"),
    ).toEqual([
      {
        method: "createCheckRun",
        args: [
          "4242",
          {
            repositoryIds: [7001],
            permissions: { checks: "write", metadata: "read" },
          },
          "acme/widgets",
          {
            name: "Code Reviewer",
            headSha: HEAD,
            status: "queued",
            externalId: "job-1",
            output: { title: "Waiting", summary: "A review is waiting." },
          },
        ],
      },
    ]);
    expect(client.calls.map((call) => call.method)).not.toContain(
      "findCheckRun",
    );
  });

  // #405-T02
  it("updates the check run it already made, without the name and the commit", async () => {
    const { client, provider } = setup();

    const published = await provider.publishReviewCheck?.(
      integration,
      widgets,
      {
        ...CHECK,
        status: "completed",
        conclusion: "success",
        title: "Review finished",
        summary: "No open findings.",
        detailsUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
      },
      { checkRunId: "9001", mayExist: false },
    );

    expect(published).toEqual({ checkRunId: "9001" });
    expect(
      client.calls.filter((call) => call.method === "updateCheckRun"),
    ).toEqual([
      {
        method: "updateCheckRun",
        args: [
          "4242",
          {
            repositoryIds: [7001],
            permissions: { checks: "write", metadata: "read" },
          },
          "acme/widgets",
          "9001",
          {
            status: "completed",
            conclusion: "success",
            externalId: "job-1",
            detailsUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
            output: { title: "Review finished", summary: "No open findings." },
          },
        ],
      },
    ]);
    expect(client.calls.map((call) => call.method)).not.toContain(
      "createCheckRun",
    );
  });

  // #405-T16
  it("looks for a check run of the job first when an earlier call may have made one, and updates it instead of creating another", async () => {
    const { client, provider } = setup({ foundCheckRun: { id: "8123" } });

    const published = await provider.publishReviewCheck?.(
      integration,
      widgets,
      CHECK,
      { checkRunId: null, mayExist: true },
    );

    expect(published).toEqual({ checkRunId: "8123" });
    expect(client.calls.map((call) => call.method)).toEqual([
      "findCheckRun",
      "updateCheckRun",
    ]);
  });

  it("creates the check run when the look finds none", async () => {
    const { client, provider } = setup();

    await provider.publishReviewCheck?.(integration, widgets, CHECK, {
      checkRunId: null,
      mayExist: true,
    });

    expect(client.calls.map((call) => call.method)).toEqual([
      "findCheckRun",
      "createCheckRun",
    ]);
  });

  // #405-T12
  it("reports a permission the App does not hold as a refused scope, from the token request or from the call", async () => {
    const duringToken = new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "GitHub answered 422.",
      { status: 422, duringTokenRequest: true },
    );
    const onCall = new GithubAppError(
      "GITHUB_APP_FORBIDDEN",
      "GitHub answered 403.",
      { status: 403 },
    );

    for (const failure of [duringToken, onCall]) {
      const { provider } = setup({ checkRunFailure: failure });
      expect(
        await failureOf(
          provider.publishReviewCheck?.(integration, widgets, CHECK, {
            checkRunId: null,
            mayExist: false,
          }),
        ),
      ).toMatchObject({ code: "INTEGRATION_ACCESS_SCOPE_REFUSED" });
    }
  });

  // #405-T15
  it.each([
    ["GITHUB_APP_NOT_FOUND", "INTEGRATION_ACCESS_CONNECTION_GONE"],
    ["GITHUB_APP_RATE_LIMITED", "INTEGRATION_ACCESS_RATE_LIMITED"],
    ["GITHUB_APP_UNAVAILABLE", "INTEGRATION_ACCESS_UNAVAILABLE"],
  ] as const)(
    "turns %s into the provider neutral code %s",
    async (githubCode, code) => {
      const { provider } = setup({
        checkRunFailure: new GithubAppError(githubCode, "GitHub answered."),
      });

      expect(
        await failureOf(
          provider.publishReviewCheck?.(integration, widgets, CHECK, {
            checkRunId: null,
            mayExist: false,
          }),
        ),
      ).toMatchObject({ code });
    },
  );

  it("refuses a repository that does not belong to the integration, without any request", async () => {
    const { client, provider } = setup();

    expect(
      await failureOf(
        provider.publishReviewCheck?.(
          integration,
          { ...widgets, integrationId: "another" },
          CHECK,
          { checkRunId: null, mayExist: false },
        ),
      ),
    ).toMatchObject({ code: "INTEGRATION_ACCESS_SCOPE_REFUSED" });
    expect(client.calls).toEqual([]);
  });
});

describe("submitting the verdict of a review", () => {
  const verdict = {
    jobId: "job-1",
    headSha: HEAD,
    event: "request_changes",
    body: "Blocking findings.\n<!-- marker -->",
    marker: "<!-- marker -->",
  } as const;

  // #405-T20
  it("submits the review with a token limited to the repository and the pull request permission", async () => {
    const { client, provider } = setup();

    const submitted = await provider.submitReviewVerdict?.(
      integration,
      widgets,
      7,
      verdict,
      { lookForEarlier: false },
    );

    expect(submitted).toEqual({ outcome: "submitted", reviewId: "6001" });
    expect(
      client.calls.filter((call) => call.method === "createPullRequestReview"),
    ).toEqual([
      {
        method: "createPullRequestReview",
        args: [
          "4242",
          {
            repositoryIds: [7001],
            permissions: { pull_requests: "write", metadata: "read" },
          },
          "acme/widgets",
          7,
          {
            commitId: HEAD,
            body: "Blocking findings.\n<!-- marker -->",
            event: "REQUEST_CHANGES",
          },
        ],
      },
    ]);
  });

  // #405-T25
  it("submits nothing when its own review with the marker is there already, and says which", async () => {
    const { client, provider } = setup({
      reviews: {
        "acme/widgets#7": [
          {
            id: "77",
            body: verdict.body,
            authorLogin: "code-reviewer-test[bot]",
            state: "CHANGES_REQUESTED",
          },
        ],
      },
    });

    const submitted = await provider.submitReviewVerdict?.(
      integration,
      widgets,
      7,
      verdict,
      { lookForEarlier: true },
    );

    expect(submitted).toEqual({ outcome: "already_there", reviewId: "77" });
    expect(client.calls.map((call) => call.method)).not.toContain(
      "createPullRequestReview",
    );
  });

  // #405-T25
  it("submits when the marker is only in a review of somebody else", async () => {
    const { client, provider } = setup({
      reviews: {
        "acme/widgets#7": [
          {
            id: "77",
            body: verdict.body,
            authorLogin: "mallory",
            state: "APPROVED",
          },
        ],
      },
    });

    const submitted = await provider.submitReviewVerdict?.(
      integration,
      widgets,
      7,
      verdict,
      { lookForEarlier: true },
    );

    expect(submitted).toMatchObject({ outcome: "submitted" });
    expect(client.calls.map((call) => call.method)).toContain(
      "createPullRequestReview",
    );
  });

  // #405-T26
  it("reports a review GitHub refuses as a refused request, and a forbidden call as a refused scope", async () => {
    const refused = new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "GitHub answered 422.",
      { status: 422 },
    );
    const forbidden = new GithubAppError(
      "GITHUB_APP_FORBIDDEN",
      "GitHub answered 403.",
      { status: 403 },
    );

    const forbiddenFor = (
      refusal: "permission_missing" | "repository_archived" | "other",
    ) =>
      new GithubAppError("GITHUB_APP_FORBIDDEN", "GitHub answered 403.", {
        status: 403,
        refusal,
      });
    const outside = new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "GitHub answered 422.",
      {
        status: 422,
        duringTokenRequest: true,
        refusal: "repository_not_accessible",
      },
    );

    // #405-T12 (review P2-7): only a missing permission is a missing permission.
    for (const [failure, code] of [
      [refused, "INTEGRATION_REQUEST_REFUSED"],
      [forbidden, "INTEGRATION_ACCESS_SCOPE_REFUSED"],
      [forbiddenFor("permission_missing"), "INTEGRATION_ACCESS_SCOPE_REFUSED"],
      [forbiddenFor("repository_archived"), "INTEGRATION_REPOSITORY_ARCHIVED"],
      [forbiddenFor("other"), "INTEGRATION_ACCESS_CONNECTION_SUSPENDED"],
      [outside, "INTEGRATION_REPOSITORY_NOT_ACCESSIBLE"],
    ] as const) {
      const { provider } = setup({ reviewFailure: failure });
      expect(
        await failureOf(
          provider.submitReviewVerdict?.(integration, widgets, 7, verdict, {
            lookForEarlier: false,
          }),
        ),
      ).toMatchObject({ code });
    }
  });
});
