// Pins down the control endpoint with which a Playwright journey adds a pull request to the fake
// GitHub that runs as its own process: what it adds is what the app's real client reads back over
// HTTP, and adding the same number again replaces the pull request.
import { describe, expect, it } from "vitest";
import { createGithubAppClient } from "../../src/integrations/providers/github-app/client.ts";
import { loadGithubAppConfig } from "../../src/integrations/providers/github-app/config.ts";
import { startGithubAppHarness } from "../../src/test-support/github-app-harness.ts";

async function setup() {
  const { fake, clock, env } = await startGithubAppHarness();
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
  });
  const post = (body: unknown) =>
    fetch(`${fake.baseUrl}/__fake/pull-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { client, post };
}

const pullRequest = (title: string, headSha = "a".repeat(40)) => ({
  number: 7,
  title,
  state: "open",
  headSha,
  headRef: "feature",
  baseRef: "main",
  author: { login: "alice", id: 1001 },
});

describe("the pull requests control endpoint of the fake GitHub", () => {
  it("adds a pull request that the app's client reads back, and replaces one with the same number", async () => {
    const { client, post } = await setup();

    const first = await post({
      repository: "acme/widgets",
      pullRequest: pullRequest("First title"),
    });
    const second = await post({
      repository: "acme/widgets",
      pullRequest: pullRequest("Second title", "b".repeat(40)),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(
      await client.getPullRequest("4242", "acme/widgets", 7),
    ).toMatchObject({
      number: 7,
      title: "Second title",
      headSha: "b".repeat(40),
      state: "open",
    });
    expect(
      await client.listOpenPullRequests("4242", "acme/widgets"),
    ).toHaveLength(1);
  });

  it("refuses a body that is not a repository with a pull request, with 400", async () => {
    const { post } = await setup();

    for (const body of [
      {},
      { repository: "acme/widgets" },
      { repository: 7, pullRequest: pullRequest("x") },
      { repository: "acme/widgets", pullRequest: { number: "7" } },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});
