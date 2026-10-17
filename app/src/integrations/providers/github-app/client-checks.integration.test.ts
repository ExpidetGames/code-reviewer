// SPDX-License-Identifier: Apache-2.0

// Pins down the check runs and pull request reviews of the GitHub client against the fake GitHub over real HTTP
// (#405): which token each call uses (one repository, the least permissions, switched off afterwards), what is
// sent, that a check run is found again by its external id, and that every failure becomes a stable code.
import { describe, expect, it } from "vitest";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const CHECKS_SCOPE = {
  repositoryIds: [7001],
  permissions: { checks: "write", metadata: "read" },
} as const;
const REVIEW_SCOPE = {
  repositoryIds: [7001],
  permissions: { pull_requests: "write", metadata: "read" },
} as const;

async function setup(options: { revokeTimeoutMs?: number } = {}) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  const client = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
    ...options,
  });
  return { fake, client };
}

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

describe("check runs, written with a narrow token", () => {
  // #405-T01
  it("creates a queued check run on the head commit with a token limited to the repository and the checks permission", async () => {
    const { fake, client } = await setup();

    const created = await client.createCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        externalId: "job-1",
        output: { title: "Waiting", summary: "A review is waiting." },
      },
    );

    expect(created.id).toMatch(/^\d+$/);
    expect(fake.checkRuns("acme/widgets")).toMatchObject([
      {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        externalId: "job-1",
        output: { title: "Waiting" },
      },
    ]);
    expect(fake.tokenRequests()).toEqual([
      {
        installationId: 4242,
        repositories: null,
        repositoryIds: [7001],
        permissions: { checks: "write", metadata: "read" },
      },
    ]);
  });

  // #405-T02
  it("updates a check run in place through its states and keeps every state it was in", async () => {
    const { fake, client } = await setup();
    const { id } = await client.createCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      { name: "Code Reviewer", headSha: HEAD, status: "queued" },
    );

    await client.updateCheckRun("4242", CHECKS_SCOPE, "acme/widgets", id, {
      status: "in_progress",
    });
    await client.updateCheckRun("4242", CHECKS_SCOPE, "acme/widgets", id, {
      status: "completed",
      conclusion: "success",
      detailsUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1",
      output: { title: "Review finished", summary: "No open findings." },
    });

    const [run, ...others] = fake.checkRuns("acme/widgets");
    expect(others).toEqual([]);
    expect(run?.history.map((state) => state.status)).toEqual([
      "queued",
      "in_progress",
      "completed",
    ]);
    expect(run).toMatchObject({
      conclusion: "success",
      detailsUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1",
    });
  });

  it("switches the token off after the call, whether it worked or not", async () => {
    const { fake, client } = await setup();

    await client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
      name: "Code Reviewer",
      headSha: HEAD,
      status: "queued",
    });
    expect(fake.revokedInstallationTokens()).toHaveLength(1);

    await failureOf(
      client.updateCheckRun("4242", CHECKS_SCOPE, "acme/widgets", "1", {
        status: "in_progress",
      }),
    );
    expect(fake.revokedInstallationTokens()).toHaveLength(2);
  });

  // #405-T16
  it("finds a check run again by its external id on the commit, and not one of another job", async () => {
    const { client } = await setup();
    const mine = await client.createCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        externalId: "job-1",
      },
    );
    await client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
      name: "Code Reviewer",
      headSha: HEAD,
      status: "queued",
      externalId: "job-2",
    });

    const found = await client.findCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      { headSha: HEAD, name: "Code Reviewer", externalId: "job-1" },
    );
    const missing = await client.findCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      { headSha: HEAD, name: "Code Reviewer", externalId: "job-3" },
    );

    expect(found).toEqual({ id: mine.id });
    expect(missing).toBeNull();
  });

  // #405-T12
  it("fails with a forbidden code when the token was minted without the checks permission being granted to the app", async () => {
    const { fake, client } = await setup();
    fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      issues: "write",
    });

    const error = await failureOf(
      client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
      }),
    );

    // GitHub refuses the token request for a permission the App does not hold with a 422.
    expect(error).toMatchObject({
      code: "GITHUB_APP_REQUEST_FAILED",
      status: 422,
      duringTokenRequest: true,
      refusal: "permission_missing",
    });
    expect(fake.checkRuns("acme/widgets")).toEqual([]);
  });

  // #405-T12 (review P2-7): a 403 does not always mean a missing permission.
  it.each([
    ["Resource not accessible by integration", "permission_missing"],
    ["Repository was archived so is read-only.", "repository_archived"],
    ["Something else GitHub says", "other"],
  ] as const)(
    "reads why GitHub refused a check run with 403 (%s)",
    async (message, refusal) => {
      const { fake, client } = await setup();
      fake.fail({ pathIncludes: "/check-runs", status: 403, message });

      const error = await failureOf(
        client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
          name: "Code Reviewer",
          headSha: HEAD,
          status: "queued",
        }),
      );

      expect(error).toMatchObject({ code: "GITHUB_APP_FORBIDDEN", refusal });
      // What GitHub said is never part of the error.
      expect(String((error as Error).message)).not.toContain(message);
    },
  );

  // #405-T12 (review P2-7)
  it("reads that a repository is not in the installation when the token is requested", async () => {
    const { client } = await setup();

    const error = await failureOf(
      client.createCheckRun(
        "4242",
        { repositoryIds: [999999], permissions: CHECKS_SCOPE.permissions },
        "acme/widgets",
        { name: "Code Reviewer", headSha: HEAD, status: "queued" },
      ),
    );

    expect(error).toMatchObject({
      duringTokenRequest: true,
      refusal: "repository_not_accessible",
    });
  });

  // #405-T16 (review P3-7)
  it("finds a check run that is not on the first page of the commit's check runs", async () => {
    const { fake, client } = await setup();
    for (let n = 0; n < 130; n += 1)
      await client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        externalId: `job-${String(n)}`,
      });

    const found = await client.findCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      { headSha: HEAD, name: "Code Reviewer", externalId: "job-129" },
    );

    expect(found?.id).toBe(String(fake.checkRuns("acme/widgets")[129]?.id));
  });

  // #405-T32 (review round 2): the token is switched off after the call, and that does not outlast the time of the sync.
  it("does not wait for a slow switch-off of the token longer than its own short timeout", async () => {
    const { fake, client } = await setup({ revokeTimeoutMs: 300 });
    fake.fail({ pathIncludes: "/installation/token", hang: true });

    const started = Date.now();
    await client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
      name: "Code Reviewer",
      headSha: HEAD,
      status: "queued",
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.checkRuns("acme/widgets")).toHaveLength(1);
  });

  // #405-T32 (review round 2)
  it("does not wait for the switch-off at all once the time of the sync is over, but still asks for it", async () => {
    const { fake, client } = await setup({ revokeTimeoutMs: 5000 });
    // The call itself hangs until the time of the sync is over; the switch-off hangs too.
    fake.fail({ pathIncludes: "/check-runs", hang: true });
    fake.fail({ pathIncludes: "/installation/token", hang: true });
    const signal = AbortSignal.timeout(300);

    const started = Date.now();
    const error = await failureOf(
      client.createCheckRun(
        "4242",
        CHECKS_SCOPE,
        "acme/widgets",
        { name: "Code Reviewer", headSha: HEAD, status: "queued" },
        signal,
      ),
    );

    expect(error).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(2000);
    // The token was still switched off (the request was made, the answer is not waited for).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      fake
        .requests()
        .some(
          (item) =>
            item.method === "DELETE" &&
            item.path.includes("/installation/token"),
        ),
    ).toBe(true);
  });

  // #405-T16 (review round 2)
  it("finds the check run of a job even when a later job has one of the same name on the same commit", async () => {
    const { fake, client } = await setup();
    for (const job of ["job-1", "job-2"])
      await client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        externalId: job,
      });

    const found = await client.findCheckRun(
      "4242",
      CHECKS_SCOPE,
      "acme/widgets",
      { headSha: HEAD, name: "Code Reviewer", externalId: "job-1" },
    );

    expect(found?.id).toBe(String(fake.checkRuns("acme/widgets")[0]?.id));
  });

  // #405-T24 (review P3-7)
  it("is refused a review on a commit the pull request never had", async () => {
    const { client } = await setup();

    const error = await failureOf(
      client.createPullRequestReview("4242", REVIEW_SCOPE, "acme/widgets", 7, {
        commitId: "9".repeat(40),
        body: "x",
        event: "APPROVE",
      }),
    );

    expect(error).toMatchObject({ status: 422 });
  });

  // #405-T22 (review P2-1)
  it("dismisses a review with a message, with a token for the pull request permission alone", async () => {
    const { fake, client } = await setup();
    const asked = await client.createPullRequestReview(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
      { commitId: HEAD, body: "changes", event: "REQUEST_CHANGES" },
    );

    await client.dismissPullRequestReview(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
      asked.id,
      "Switched off.",
    );

    expect(fake.pullRequestReviews("acme/widgets", 7)).toMatchObject([
      { state: "DISMISSED", dismissalMessage: "Switched off." },
    ]);
    expect(fake.pullRequestReviewDecisions("acme/widgets", 7)).toEqual({});
  });

  // #405-T22 (review P2-1)
  it("cannot dismiss a review twice or one that is not there", async () => {
    const { client } = await setup();
    const asked = await client.createPullRequestReview(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
      { commitId: HEAD, body: "changes", event: "REQUEST_CHANGES" },
    );
    const dismiss = (id: string) =>
      client.dismissPullRequestReview(
        "4242",
        REVIEW_SCOPE,
        "acme/widgets",
        7,
        id,
        "Switched off.",
      );
    await dismiss(asked.id);

    expect(await failureOf(dismiss(asked.id))).toMatchObject({ status: 422 });
    expect(await failureOf(dismiss("1"))).toMatchObject({ status: 404 });
  });

  // #405-T15
  it.each([
    [403, "GITHUB_APP_FORBIDDEN"],
    [404, "GITHUB_APP_NOT_FOUND"],
    [502, "GITHUB_APP_UNAVAILABLE"],
  ] as const)(
    "fails with a stable code when GitHub answers %s",
    async (status, code) => {
      const { fake, client } = await setup();
      fake.fail({ pathIncludes: "/check-runs", status });

      expect(
        await failureOf(
          client.createCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
            name: "Code Reviewer",
            headSha: HEAD,
            status: "queued",
          }),
        ),
      ).toMatchObject({ code });
    },
  );

  it("refuses a repository name, a check run id or an installation id that is not one, before any request", async () => {
    const { fake, client } = await setup();

    await failureOf(
      client.createCheckRun("4242", CHECKS_SCOPE, "../x", {
        name: "n",
        headSha: HEAD,
        status: "queued",
      }),
    );
    await failureOf(
      client.updateCheckRun("4242", CHECKS_SCOPE, "acme/widgets", "../1", {
        status: "in_progress",
      }),
    );
    await failureOf(
      client.findCheckRun("abc", CHECKS_SCOPE, "acme/widgets", {
        headSha: HEAD,
        name: "n",
        externalId: "x",
      }),
    );
    await failureOf(
      client.findCheckRun("4242", CHECKS_SCOPE, "acme/widgets", {
        headSha: "not-a-sha",
        name: "n",
        externalId: "x",
      }),
    );

    expect(fake.requests()).toEqual([]);
  });
});

describe("pull request reviews, written and read with a narrow token", () => {
  // #405-T20
  it("submits a review as the bot of the app on the head commit with a token limited to the repository and the pull request permission", async () => {
    const { fake, client } = await setup();

    const created = await client.createPullRequestReview(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
      { commitId: HEAD, body: "Blocking findings.", event: "REQUEST_CHANGES" },
    );

    expect(created.id).toMatch(/^\d+$/);
    expect(fake.pullRequestReviews("acme/widgets", 7)).toMatchObject([
      {
        login: "fake-app[bot]",
        state: "CHANGES_REQUESTED",
        body: "Blocking findings.",
        commitId: HEAD,
      },
    ]);
    expect(fake.tokenRequests()).toEqual([
      {
        installationId: 4242,
        repositories: null,
        repositoryIds: [7001],
        permissions: { pull_requests: "write", metadata: "read" },
      },
    ]);
    expect(fake.revokedInstallationTokens()).toHaveLength(1);
  });

  // #405-T25
  it("lists the reviews of a pull request with their author, state and body", async () => {
    const { fake, client } = await setup();
    fake.addPullRequestReview("acme/widgets", 7, {
      login: "carol",
      event: "APPROVE",
      body: "Looks fine",
    });
    await client.createPullRequestReview(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
      { commitId: HEAD, body: "marker", event: "APPROVE" },
    );

    const reviews = await client.listPullRequestReviews(
      "4242",
      REVIEW_SCOPE,
      "acme/widgets",
      7,
    );

    expect(reviews).toEqual([
      expect.objectContaining({
        authorLogin: "carol",
        state: "APPROVED",
        body: "Looks fine",
      }),
      expect.objectContaining({
        authorLogin: "fake-app[bot]",
        state: "APPROVED",
        body: "marker",
      }),
    ]);
  });

  // #405-T26
  it("fails with a stable code when GitHub refuses the review", async () => {
    const { fake, client } = await setup();
    fake.addPullRequest("acme/widgets", {
      number: 8,
      title: "Written by the app",
      state: "open",
      headSha: HEAD,
      headRef: "bot/change",
      baseRef: "main",
      author: { login: "fake-app[bot]", id: 1 },
    });

    const own = await failureOf(
      client.createPullRequestReview("4242", REVIEW_SCOPE, "acme/widgets", 8, {
        commitId: HEAD,
        body: "x",
        event: "APPROVE",
      }),
    );
    fake.fail({ pathIncludes: "/pulls/7/reviews", status: 403 });
    const forbidden = await failureOf(
      client.createPullRequestReview("4242", REVIEW_SCOPE, "acme/widgets", 7, {
        commitId: HEAD,
        body: "x",
        event: "APPROVE",
      }),
    );

    expect(own).toMatchObject({
      code: "GITHUB_APP_REQUEST_FAILED",
      status: 422,
    });
    expect(forbidden).toMatchObject({ code: "GITHUB_APP_FORBIDDEN" });
  });

  it("refuses a repository name or a number that is not one, before any request", async () => {
    const { fake, client } = await setup();

    await failureOf(
      client.createPullRequestReview("4242", REVIEW_SCOPE, "../x", 7, {
        commitId: HEAD,
        body: "x",
        event: "APPROVE",
      }),
    );
    await failureOf(
      client.listPullRequestReviews("4242", REVIEW_SCOPE, "acme/widgets", 0),
    );

    expect(fake.requests()).toEqual([]);
  });
});
