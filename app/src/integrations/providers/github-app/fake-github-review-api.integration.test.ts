// SPDX-License-Identifier: Apache-2.0

// Pins down the part of the fake GitHub that a reviewer uses (fakes/github/review-api.ts) over real
// HTTP, with installation tokens minted by the app's real client: the diff and the contents of a
// pull request, comments written and edited in place as the bot of the app, what a token without
// the permission is refused, and links that point to the fake itself when asked. The journey with
// the real runner and PR-Agent (e2e/jobs) relies on all of it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
  type FakePullRequest,
} from "../../../../../fakes/github/server.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import {
  testGithubAppEnv,
  TEST_APP_ID,
  testAppKeys,
} from "../../../test-support/github-app.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";

const OWNER = { login: "acme", id: 5001, type: "Organization" } as const;
const WIDGETS = { id: 7001, fullName: "acme/widgets" };
const PULL: FakePullRequest = {
  number: 7,
  title: "Add a greeting helper",
  state: "open",
  headSha: "1".repeat(40),
  headRef: "feature/greeting",
  baseRef: "main",
  author: { login: "alice", id: 1001 },
};

async function setup(options: { selfLinks?: boolean } = {}) {
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
    appSlug: "code-reviewer-test",
    ...options,
  });
  cleanUpAfterTest(() => fake.close());
  fake.addInstallation({ id: 4242, account: OWNER });
  fake.setRepositories(4242, [WIDGETS]);
  fake.addPullRequest(WIDGETS.fullName, PULL);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(
      testGithubAppEnv({
        GITHUB_API_BASE_URL: fake.baseUrl,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
      }),
    ),
  });
  return { fake, client };
}

/** A token for the widgets repository, with these permissions. */
async function tokenWith(
  client: Awaited<ReturnType<typeof setup>>["client"],
  permissions: Record<string, "read" | "write">,
): Promise<string> {
  const minted = await client.mintInstallationToken("4242", {
    repositoryIds: [WIDGETS.id],
    permissions,
  });
  return minted.token;
}

const REVIEWER = {
  pull_requests: "write",
  issues: "write",
  contents: "read",
  metadata: "read",
} as const;

/** What PyGithub does: the `token` scheme of the Authorization header. */
async function call(
  fake: FakeGithub,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${fake.baseUrl}${path}`, {
    method,
    headers: { authorization: `token ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? undefined : (JSON.parse(text) as unknown),
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers of the fake, read field by field

describe("the pull request as a reviewer reads it", () => {
  it("serves the files, the commit and the contents at the head and at the base", async () => {
    const { fake, client } = await setup();
    const token = await tokenWith(client, REVIEWER);

    const pull = await call(fake, token, "GET", "/repos/acme/widgets/pulls/7");
    const files = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/pulls/7/files",
    );
    const commits = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/pulls/7/commits",
    );
    const atHead = await call(
      fake,
      token,
      "GET",
      `/repos/acme/widgets/contents/greeting.py?ref=${PULL.headSha}`,
    );
    const atBase = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/contents/greeting.py",
    );
    const missing = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/contents/AGENTS.md",
    );

    expect((pull.json as Json).head.sha).toBe(PULL.headSha);
    expect((pull.json as Json).changed_files).toBe(1);
    expect((files.json as Json[])[0]?.filename).toBe("greeting.py");
    expect((files.json as Json[])[0]?.patch).toContain("+def farewell");
    expect((commits.json as Json[])[0]?.sha).toBe(PULL.headSha);
    const text = (answer: { json: unknown }) =>
      Buffer.from((answer.json as Json).content as string, "base64").toString();
    expect(text(atHead)).toContain("def farewell");
    expect(text(atBase)).not.toContain("def farewell");
    expect(missing.status).toBe(404);
  });

  it("keeps the links on the fake itself when asked, and on an unreachable host otherwise", async () => {
    const own = await setup({ selfLinks: true });
    const other = await setup();

    const ownPull = await call(
      own.fake,
      await tokenWith(own.client, REVIEWER),
      "GET",
      "/repos/acme/widgets/pulls/7",
    );
    const otherPull = await call(
      other.fake,
      await tokenWith(other.client, REVIEWER),
      "GET",
      "/repos/acme/widgets/pulls/7",
    );

    expect((ownPull.json as Json).html_url).toBe(
      `${own.fake.baseUrl}/acme/widgets/pull/7`,
    );
    expect((otherPull.json as Json).html_url).toBe(
      "https://github.test/acme/widgets/pull/7",
    );
  });
});

describe("a repository with several pull requests", () => {
  const SECOND: FakePullRequest = {
    ...PULL,
    number: 8,
    headSha: "2".repeat(40),
    headRef: "feature/farewell",
  };

  it("serves the pull request that has the head a commit or ref names, and refuses a ref that is none", async () => {
    const { fake, client } = await setup();
    fake.addPullRequest(WIDGETS.fullName, SECOND);
    const token = await tokenWith(client, REVIEWER);

    const named = await call(
      fake,
      token,
      "GET",
      `/repos/acme/widgets/commits/${SECOND.headSha}`,
    );
    const unknown = await call(
      fake,
      token,
      "GET",
      `/repos/acme/widgets/commits/${"3".repeat(40)}`,
    );

    expect((named.json as Json).sha).toBe(SECOND.headSha);
    expect(unknown.status).toBe(404);
  });

  it("serves a file at the base only when every pull request that has it agrees on its text", async () => {
    const { fake, client } = await setup();
    const token = await tokenWith(client, REVIEWER);
    fake.addPullRequest(WIDGETS.fullName, SECOND);

    const agreed = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/contents/greeting.py",
    );
    fake.addPullRequest(WIDGETS.fullName, {
      ...SECOND,
      files: [
        {
          filename: "greeting.py",
          baseContent: "something else\n",
          headContent: "changed\n",
          patch: "@@ -1 +1 @@\n-something else\n+changed\n",
        },
      ],
    });
    const disagreed = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/contents/greeting.py",
    );

    expect(agreed.status).toBe(200);
    expect(disagreed.status).toBe(404);
  });
});

describe("comments below a pull request", () => {
  it("writes a comment as the bot of the app and edits it in place instead of adding another", async () => {
    const { fake, client } = await setup({ selfLinks: true });
    const token = await tokenWith(client, REVIEWER);

    const created = await call(
      fake,
      token,
      "POST",
      "/repos/acme/widgets/issues/7/comments",
      { body: "first review" },
    );
    const id = (created.json as Json).id as number;
    const edited = await call(
      fake,
      token,
      "PATCH",
      `/repos/acme/widgets/issues/comments/${String(id)}`,
      { body: "second review" },
    );
    const listed = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/issues/7/comments",
    );

    expect(created.status).toBe(201);
    expect((created.json as Json).user.login).toBe("code-reviewer-test[bot]");
    expect((created.json as Json).html_url).toBe(
      `${fake.baseUrl}/acme/widgets/pull/7#issuecomment-${String(id)}`,
    );
    expect(edited.status).toBe(200);
    expect((listed.json as Json[]).map((comment) => comment.body)).toEqual([
      "second review",
    ]);
    expect(fake.pullRequestComments("acme/widgets", 7)).toMatchObject([
      { id, body: "second review", revision: 2 },
    ]);
  });

  it("deletes a comment", async () => {
    const { fake, client } = await setup();
    const token = await tokenWith(client, REVIEWER);
    const comment = fake.addPullRequestComment("acme/widgets", 7, "temporary");

    const deleted = await call(
      fake,
      token,
      "DELETE",
      `/repos/acme/widgets/issues/comments/${String(comment.id)}`,
    );

    expect(deleted.status).toBe(204);
    expect(fake.pullRequestComments("acme/widgets", 7)).toEqual([]);
  });

  it("refuses a comment that is longer than GitHub takes", async () => {
    const { fake, client } = await setup();
    const token = await tokenWith(client, REVIEWER);

    const refused = await call(
      fake,
      token,
      "POST",
      "/repos/acme/widgets/issues/7/comments",
      { body: "x".repeat(65537) },
    );

    expect(refused.status).toBe(422);
    expect(fake.pullRequestComments("acme/widgets", 7)).toEqual([]);
  });

  it("refuses to write a comment with a token that may only read", async () => {
    const { fake, client } = await setup();
    const token = await tokenWith(client, {
      pull_requests: "read",
      issues: "read",
      metadata: "read",
    });

    const read = await call(
      fake,
      token,
      "GET",
      "/repos/acme/widgets/issues/7/comments",
    );
    const write = await call(
      fake,
      token,
      "POST",
      "/repos/acme/widgets/issues/7/comments",
      { body: "no" },
    );

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect(fake.pullRequestComments("acme/widgets", 7)).toEqual([]);
  });

  it("refuses a caller without a valid installation token", async () => {
    const { fake } = await setup();

    const answer = await call(
      fake,
      "ghs_unknown",
      "GET",
      "/repos/acme/widgets/issues/7/comments",
    );

    expect(answer.status).toBe(401);
  });
});
