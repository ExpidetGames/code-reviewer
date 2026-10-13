// SPDX-License-Identifier: Apache-2.0

// Pins down the handlers behind the two routes of the manual start: they ask for the user first,
// check where the request comes from and what it carries, call the real service (real GitHub App
// provider against the fake GitHub, real queue, real SQLite file) and answer with a stable code. The
// proxy in front of the real routes is tested in
// integration-tests/http/manual-review-route.integration.test.ts.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import {
  pullRequest,
  startManualReviewHarness,
} from "../test-support/manual-review-harness.ts";
import { createManualReviewRouteHandlers } from "./http.ts";

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;

async function setup(
  requireUser: () => Promise<SessionUser> = async () => USER,
) {
  const app = await startManualReviewHarness();
  const handlers = createManualReviewRouteHandlers({
    requireUser,
    service: app.service,
  });
  const url = (repositoryId: string, path: string) =>
    `https://app.test/api/repositories/${repositoryId}/${path}`;
  const post = (
    body: unknown,
    options: {
      repositoryId?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const repositoryId = options.repositoryId ?? app.repository.id;
    return handlers.start(
      new Request(url(repositoryId, "reviews"), {
        method: "POST",
        headers: options.headers ?? { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      repositoryId,
    );
  };
  const get = (repositoryId = app.repository.id) =>
    handlers.list(
      new Request(url(repositoryId, "pull-requests")),
      repositoryId,
    );
  return { ...app, handlers, post, get };
}

describe("loading the pull requests over HTTP", () => {
  // CR-33-T01
  it("answers the open pull requests with the commands the project allows", async () => {
    const { h, get, repository } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(1));
    h.fake.addPullRequest("acme/widgets", pullRequest(2, { state: "closed" }));
    h.fake.addPullRequest("acme/widgets", pullRequest(3));

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      repositoryId: repository.id,
      fullName: "acme/widgets",
      allowedCommands: ["review"],
      pullRequests: [
        { number: 3, title: "Change number 3", author: "alice" },
        { number: 1, title: "Change number 1", author: "alice" },
      ],
    });
  });

  // CR-33-T07
  it("answers 502 with a stable code when GitHub fails", async () => {
    const { h, get } = await setup();
    h.fake.fail({ pathIncludes: "/pulls", status: 500 });

    const response = await get();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "MANUAL_REVIEW_GITHUB_UNAVAILABLE",
    });
  });

  // CR-33-T08
  it("answers 409 that the app is not installed, without a token or a raw answer", async () => {
    const { h, get } = await setup();
    h.fake.fail({ pathIncludes: "/pulls", status: 404 });

    const response = await get();
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toEqual({
      error: "MANUAL_REVIEW_APP_NOT_INSTALLED",
    });
    for (const credential of h.fake.seenCredentials())
      expect(text).not.toContain(credential);
  });

  // CR-33-T13
  it("answers 404 for a repository that is no active project", async () => {
    const { get } = await setup();

    const response = await get("no-such-repository");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "MANUAL_REVIEW_PROJECT_NOT_FOUND",
    });
  });
});

describe("starting a command over HTTP", () => {
  // CR-33-T04
  it("answers 201 with the new run and creates the manual job for the signed in person", async () => {
    const { h, post, queue } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    const response = await post({ prNumber: 7, command: "review" });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = (await response.json()) as { runId: string };
    expect(answer).toEqual({
      runId: expect.any(String),
      created: true,
      prNumber: 7,
      command: "review",
    });
    expect(await queue.list()).toMatchObject([
      {
        id: answer.runId,
        command: "review",
        triggerKind: "manual",
        actorLogin: "octocat",
        status: "queued",
      },
    ]);
  });

  it("takes the person from the session and ignores one named in the body", async () => {
    const { h, post, queue } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    await post({ prNumber: 7, command: "review", actorLogin: "mallory" });

    expect(await queue.list()).toMatchObject([{ actorLogin: "octocat" }]);
  });

  // CR-33-T10
  it("answers 200 with the existing run when the same review is started again", async () => {
    const { h, post, queue } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const first = (await (
      await post({ prNumber: 7, command: "review" })
    ).json()) as { runId: string };

    const response = await post({ prNumber: 7, command: "review" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: first.runId,
      created: false,
    });
    expect(await queue.list()).toHaveLength(1);
  });

  // CR-33-T09
  it("answers 409 for a pull request that is closed now, and creates no job", async () => {
    const { h, post, queue } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(7, { state: "closed" }));

    const response = await post({ prNumber: 7, command: "review" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN",
    });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T13
  it("answers 404 for a repository that is no active project, and creates no job", async () => {
    const { h, post, queue } = await setup();
    h.fake.addPullRequest("acme/widgets", pullRequest(7));

    const response = await post(
      { prNumber: 7, command: "review" },
      { repositoryId: "no-such-repository" },
    );

    expect(response.status).toBe(404);
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T13
  it("answers 404 for a pull request number the repository does not have", async () => {
    const { post, queue } = await setup();

    const response = await post({ prNumber: 4711, command: "review" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND",
    });
    expect(await queue.list()).toEqual([]);
  });

  // CR-33-T14
  it.each([
    [
      { prNumber: "abc", command: "review" },
      [{ field: "prNumber", code: "invalid" }],
    ],
    [
      { prNumber: -1, command: "review" },
      [{ field: "prNumber", code: "invalid" }],
    ],
    [
      { prNumber: 7, command: "deploy" },
      [{ field: "command", code: "invalid" }],
    ],
    [{ prNumber: 7, command: "ask" }, [{ field: "command", code: "invalid" }]],
    [
      { prNumber: 7, command: "review", question: "why?" },
      [{ field: "question", code: "invalid" }],
    ],
  ])(
    "answers 400 with the field errors for %j, and creates no job",
    async (body, issues) => {
      const { post, queue } = await setup();

      const response = await post(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "MANUAL_REVIEW_REQUEST_INVALID",
        issues,
      });
      expect(await queue.list()).toEqual([]);
    },
  );

  // CR-33-T14
  it("answers 400 for a body that is not JSON", async () => {
    const { post, queue } = await setup();

    const response = await post("{not json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "MANUAL_REVIEW_REQUEST_INVALID",
    });
    expect(await queue.list()).toEqual([]);
  });

  it("answers 415 when the body is not declared as JSON", async () => {
    const { post, queue } = await setup();

    const response = await post("prNumber=7&command=review", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.status).toBe(415);
    expect(await queue.list()).toEqual([]);
  });

  it("answers 413 for a body over the limit", async () => {
    const { post, queue } = await setup();

    const response = await post({
      prNumber: 7,
      command: "review",
      question: "x".repeat(20_000),
    });

    expect(response.status).toBe(413);
    expect(await queue.list()).toEqual([]);
  });

  it.each<Record<string, string>>([
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.test" },
  ])(
    "answers 403 for a request from another site (%j), and creates no job",
    async (site) => {
      const { h, post, queue } = await setup();
      h.fake.addPullRequest("acme/widgets", pullRequest(7));

      const response = await post(
        { prNumber: 7, command: "review" },
        { headers: { "content-type": "application/json", ...site } },
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "MANUAL_REVIEW_CROSS_SITE_REQUEST",
      });
      expect(await queue.list()).toEqual([]);
    },
  );

  // CR-33-T11
  it("asks for the user before it reads anything, and a refusal reaches the caller", async () => {
    const refusal = new Error("NEXT_REDIRECT");
    const { h, post, get, queue } = await setup(async () => {
      throw refusal;
    });
    h.fake.addPullRequest("acme/widgets", pullRequest(7));
    const before = h.fake.requests().length;

    await expect(post({ prNumber: 7, command: "review" })).rejects.toBe(
      refusal,
    );
    await expect(get()).rejects.toBe(refusal);

    expect(await queue.list()).toEqual([]);
    expect(h.fake.requests()).toHaveLength(before);
  });
});
