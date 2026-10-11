// Pins down listing the open pull requests of a project and starting a command for one of them,
// with the real service, the real GitHub App provider and client against the fake GitHub, the real
// job queue and a real SQLite file. The rules are those of the other triggers: an active project, a
// command the project allows, an open pull request that GitHub itself confirms, one job at a time
// for the same pull request and command, and no debounce.
import { describe, expect, it } from "vitest";
import {
  HEAD_SHA as HEAD,
  pullRequest,
  startManualReviewHarness as start,
} from "../test-support/manual-review-harness.ts";

const USER = { githubLogin: "octocat" };

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe("listing the open pull requests of a project", () => {
  // CR-33-T01
  it("lists exactly the open pull requests with number, title and author, drafts included", async () => {
    const { h, service, repository } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(1));
    h.fake.addPullRequest("acme/widgets", pullRequest(2, { state: "closed" }));
    h.fake.addPullRequest(
      "acme/widgets",
      pullRequest(3, { draft: true, author: { login: "bob", id: 1002 } }),
    );
    h.fake.addPullRequest("acme/widgets", pullRequest(4));
    h.fake.addPullRequest(
      "acme/widgets",
      pullRequest(5, { state: "closed", merged: true }),
    );

    const result = await service.listOpenPullRequests(repository.id);

    expect(result).toMatchObject({
      repositoryId: repository.id,
      fullName: "acme/widgets",
    });
    expect(result.pullRequests).toEqual([
      expect.objectContaining({ number: 4, author: "alice", draft: false }),
      expect.objectContaining({
        number: 3,
        title: "Change number 3",
        author: "bob",
        draft: true,
      }),
      expect.objectContaining({ number: 1, author: "alice" }),
    ]);
  });

  // CR-33-T02
  it("loads every page when the repository has more open pull requests than one page holds", async () => {
    const { h, service, repository } = await start();
    for (let number = 1; number <= 230; number += 1)
      h.fake.addPullRequest("acme/widgets", pullRequest(number));
    const requestsBefore = h.fake.requests().length;

    const result = await service.listOpenPullRequests(repository.id);

    expect(result.pullRequests).toHaveLength(230);
    expect(new Set(result.pullRequests.map((pr) => pr.number)).size).toBe(230);
    expect(
      h.fake
        .requests()
        .slice(requestsBefore)
        .filter((request) => request.path.endsWith("/pulls")),
    ).toHaveLength(3);
  });

  it("answers an empty list for a repository without open pull requests", async () => {
    const { service, repository } = await start();

    expect(
      (await service.listOpenPullRequests(repository.id)).pullRequests,
    ).toEqual([]);
  });

  it("reports the commands the project allows", async () => {
    const { service, repository, settings } = await start();
    await settings.updateProjectSettings(repository.id, {
      allowedCommands: ["review", "ask"],
    });

    expect(
      (await service.listOpenPullRequests(repository.id)).allowedCommands,
    ).toEqual(["review", "ask"]);
  });

  it("leaves out everything of a pull request but what the picker shows", async () => {
    const { h, service, repository } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(1));

    const result = await service.listOpenPullRequests(repository.id);

    expect(Object.keys(result.pullRequests[0] ?? {}).sort()).toEqual([
      "author",
      "baseRef",
      "draft",
      "headRef",
      "number",
      "title",
      "url",
    ]);
    expect(JSON.stringify(result)).not.toContain(HEAD);
  });

  // CR-33-T07
  it("reports GitHub answering 500 as unavailable", async () => {
    const { h, service, repository } = await start();
    h.fake.fail({ pathIncludes: "/pulls", status: 500 });

    expect(
      await failureOf(service.listOpenPullRequests(repository.id)),
    ).toMatchObject({ code: "MANUAL_REVIEW_GITHUB_UNAVAILABLE" });
  });

  it("reports GitHub refusing the request itself (422) as unavailable, not as the app not being installed", async () => {
    const { h, service, repository } = await start();
    h.fake.fail({ pathIncludes: "/pulls", status: 422 });

    expect(
      await failureOf(service.listOpenPullRequests(repository.id)),
    ).toMatchObject({ code: "MANUAL_REVIEW_GITHUB_UNAVAILABLE" });
  });

  // CR-33-T07
  it("reports GitHub answering too slowly as unavailable", async () => {
    const { h, service, repository } = await start({ requestTimeoutMs: 150 });
    h.fake.fail({ pathIncludes: "/pulls", delayMs: 1500 });

    expect(
      await failureOf(service.listOpenPullRequests(repository.id)),
    ).toMatchObject({ code: "MANUAL_REVIEW_GITHUB_UNAVAILABLE" });
  });

  // CR-33-T08
  it.each([401, 403, 404])(
    "reports GitHub answering %i as the app not being installed, without a token or a raw answer",
    async (status) => {
      const { h, service, repository } = await start();
      h.fake.fail({ pathIncludes: "/pulls", status });

      const error = await failureOf(
        service.listOpenPullRequests(repository.id),
      );

      expect(error).toMatchObject({ code: "MANUAL_REVIEW_APP_NOT_INSTALLED" });
      for (const credential of h.fake.seenCredentials())
        expect(JSON.stringify(error) + (error as Error).message).not.toContain(
          credential,
        );
    },
  );

  it("reports an integration that was removed as the app not being installed, without asking GitHub", async () => {
    const { h, service, repository, integration } = await start();
    await h.integrations.setStatus(integration.id, "disabled");
    const before = h.fake.requests().length;

    expect(
      await failureOf(service.listOpenPullRequests(repository.id)),
    ).toMatchObject({ code: "MANUAL_REVIEW_APP_NOT_INSTALLED" });
    expect(h.fake.requests()).toHaveLength(before);
  });

  // CR-33-T13
  it("answers not found for a repository without an active project and does not ask GitHub", async () => {
    const { h, service, repository } = await start();
    await h.projects.deactivateProject(repository.id);
    const before = h.fake.requests().length;

    expect(
      await failureOf(service.listOpenPullRequests(repository.id)),
    ).toMatchObject({ code: "MANUAL_REVIEW_PROJECT_NOT_FOUND" });
    expect(h.fake.requests()).toHaveLength(before);
  });

  // CR-33-T13
  it("answers not found for a repository id nobody knows", async () => {
    const { service } = await start();

    expect(
      await failureOf(service.listOpenPullRequests("no-such-id")),
    ).toMatchObject({ code: "MANUAL_REVIEW_PROJECT_NOT_FOUND" });
  });
});

describe("starting a command for a pull request", () => {
  // CR-33-T04
  it("creates a manual job with the command, the person and the head commit GitHub reports, due at once", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const before = Date.now();

    const started = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    expect(started).toMatchObject({
      created: true,
      prNumber: 7,
      command: "review",
    });
    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: started.runId,
      repositoryId: repository.id,
      prNumber: 7,
      headSha: HEAD,
      command: "review",
      args: "",
      triggerKind: "manual",
      actorLogin: "octocat",
      deliveryId: null,
      status: "queued",
    });
    // No debounce: the job may be claimed right now.
    expect(new Date(jobs[0]?.runAfter ?? "").getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(new Date(jobs[0]?.runAfter ?? "").getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect((await queue.claimNext("runner-1"))?.job.id).toBe(started.runId);
  });

  it("uses the head commit from GitHub, whatever the browser might claim", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
      headSha: "f".repeat(40),
      actorLogin: "somebody-else",
    });

    expect(await queue.list()).toMatchObject([
      { headSha: HEAD, actorLogin: "octocat" },
    ]);
  });

  it("creates an ask job that carries the question", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "ask",
      question: "  Why was the cache removed?  ",
    });

    expect(await queue.list()).toMatchObject([
      { command: "ask", args: "Why was the cache removed?" },
    ]);
  });

  it("starts a command for a draft pull request", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7, { draft: true }));

    await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "improve",
    });

    expect(await queue.list()).toMatchObject([{ command: "improve" }]);
  });

  it("logs who started what, and never the question", async () => {
    const { h, service, repository, lines } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "ask",
      question: "secret-looking question",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("repo=acme/widgets pr=7 command=ask by=octocat");
    expect(lines[0]).not.toContain("secret-looking");
  });

  // CR-33-T09
  it("refuses a pull request that was closed after the list was shown, and creates no job", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    h.fake.updatePullRequest("acme/widgets", 7, { state: "closed" });

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T09
  it("refuses a pull request that was merged after the list was shown", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    h.fake.updatePullRequest("acme/widgets", 7, {
      state: "closed",
      merged: true,
    });

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T10
  it("returns the job that already waits for the same pull request and command instead of a second one", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const first = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    const again = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(await queue.list()).toHaveLength(1);
  });

  // CR-33-T10
  it("returns the job that is running for the same pull request and command", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const first = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });
    await queue.claimNext("runner-1");

    const again = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(await queue.list()).toHaveLength(1);
  });

  // CR-33-T10
  it("creates one job for two starts that arrive at the same time", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    const [a, b] = await Promise.all([
      service.startReview(USER, repository.id, {
        prNumber: 7,
        command: "review",
      }),
      service.startReview(USER, repository.id, {
        prNumber: 7,
        command: "review",
      }),
    ]);

    expect(a.runId).toBe(b.runId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await queue.list()).toHaveLength(1);
  });

  it("makes a debounced automatic job due now instead of adding a second one", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const automatic = await queue.enqueue({
      repositoryId: repository.id,
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      headSha: HEAD,
      command: "review",
      triggerKind: "webhook",
      actorLogin: "alice",
      deliveryId: "d-1",
      runAfter: new Date(Date.now() + 90_000),
    });

    const started = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    expect(started).toMatchObject({
      runId: automatic.job.id,
      created: false,
    });
    expect((await queue.claimNext("runner-1"))?.job.id).toBe(automatic.job.id);
  });

  it("treats another command or a new commit of the same pull request as a new job", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const review = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "review",
    });

    const describe = await service.startReview(USER, repository.id, {
      prNumber: 7,
      command: "describe",
    });

    expect(describe.created).toBe(true);
    expect(describe.runId).not.toBe(review.runId);
    expect(await queue.list()).toHaveLength(2);
  });

  it("refuses a command the project switched off, and creates no job", async () => {
    const { h, service, repository, queue, settings } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    await settings.updateProjectSettings(repository.id, {
      allowedCommands: ["review"],
    });

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "improve",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_COMMAND_NOT_ALLOWED" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T13
  it("answers not found for an inactive project, and creates no job", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    await h.projects.deactivateProject(repository.id);

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_PROJECT_NOT_FOUND" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T13
  it("answers not found for a pull request number that belongs to another repository", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.setRepositories(4242, [
      { id: 7001, fullName: "acme/widgets" },
      { id: 7002, fullName: "acme/gadgets" },
    ]);
    h.fake.addPullRequest("acme/gadgets", pullRequest(99));

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 99,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T14
  it("refuses an invalid body with the fields that are wrong, before it asks GitHub", async () => {
    const { h, service, repository, queue } = await start();
    const before = h.fake.requests().length;

    const error = await failureOf(
      service.startReview(USER, repository.id, {
        prNumber: "abc",
        command: "deploy",
      }),
    );

    expect(error).toMatchObject({
      code: "MANUAL_REVIEW_REQUEST_INVALID",
      issues: [
        { field: "prNumber", code: "invalid" },
        { field: "command", code: "invalid" },
      ],
    });
    expect(await queue.list()).toEqual([]);
    expect(h.fake.requests()).toHaveLength(before);
  });

  it("reports GitHub being down while the pull request is checked, and creates no job", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    h.fake.fail({ pathIncludes: "/pulls/7", status: 500 });

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_GITHUB_UNAVAILABLE" });
    expect(await queue.list()).toEqual([]);
  });

  it("reports a job the queue does not accept as an invalid request, not as GitHub being down", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest(
      "acme/widgets",
      pullRequest(7, { headSha: "abc123" }),
    );

    expect(
      await failureOf(
        service.startReview(USER, repository.id, {
          prNumber: 7,
          command: "review",
        }),
      ),
    ).toMatchObject({ code: "MANUAL_REVIEW_REQUEST_INVALID" });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T08
  it.each([401, 403])(
    "reports GitHub answering %i for the pull request as the app not being installed, like the list does",
    async (status) => {
      const { h, service, repository, queue } = await start();
      h.fake.addPullRequest("acme/widgets", pullRequest(7));
      h.fake.fail({ pathIncludes: "/pulls/7", status });

      expect(
        await failureOf(
          service.startReview(USER, repository.id, {
            prNumber: 7,
            command: "review",
          }),
        ),
      ).toMatchObject({ code: "MANUAL_REVIEW_APP_NOT_INSTALLED" });
      expect(await queue.list()).toEqual([]);
    },
  );

  // CR-33-T08
  it("reports a removed installation as the app not being installed, not as an unknown pull request", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    // The cached token runs out; the new token request finds no installation.
    h.clock.advance(2 * 60 * 60 * 1000);
    h.fake.removeInstallation(4242);

    const starting = await failureOf(
      service.startReview(USER, repository.id, {
        prNumber: 7,
        command: "review",
      }),
    );
    const listing = await failureOf(
      service.listOpenPullRequests(repository.id),
    );

    expect(starting).toMatchObject({ code: "MANUAL_REVIEW_APP_NOT_INSTALLED" });
    expect(listing).toMatchObject({ code: "MANUAL_REVIEW_APP_NOT_INSTALLED" });
    expect(await queue.list()).toEqual([]);
  });

  it("does not take a question that grows past the limit when its image links are replaced", async () => {
    const { h, service, repository, queue } = await start();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    const error = await failureOf(
      service.startReview(USER, repository.id, {
        prNumber: 7,
        command: "ask",
        question: "![]".repeat(666),
      }),
    );

    expect(error).toMatchObject({
      code: "MANUAL_REVIEW_REQUEST_INVALID",
      issues: [{ field: "question", code: "too_long" }],
    });
    expect(await queue.list()).toEqual([]);
  });
});
