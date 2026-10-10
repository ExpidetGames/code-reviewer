// Pins down the GitHub App provider with an in-memory client: the shared conformance suite, how
// webhook deliveries are verified and translated, who may trigger a command, and the job access it
// hands out. The HTTP client itself is tested against the fake GitHub API.
import { describe, expect, it } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../../../fakes/github/webhooks.ts";
import { describeIntegrationProviderConformance } from "../../../test-support/integration-provider-conformance.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { TEST_WEBHOOK_SECRET } from "../../../test-support/github-app.ts";
import {
  FAKE_PULL_REQUEST,
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { testGithubAppConfig } from "./test-config.ts";
import { isGitAccess } from "../../normalized.ts";
import type {
  Integration,
  IntegrationEvent,
  RepoRef,
  ReviewTrigger,
} from "../../types.ts";
import { GithubAppConfigError } from "./errors.ts";
import { createGithubAppProvider } from "./provider.ts";

const integration: Integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
  config: {
    accountLogin: "acme",
    accountId: 5001,
    accountType: "Organization",
  },
});

const widgets: RepoRef = {
  integrationId: "integration-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};

function setup(data: FakeGithubAppClientData = {}) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: testGithubAppConfig(),
    client,
  });
  return { client, provider };
}

function delivery(
  fixture: string,
  options: { secret?: string; signature?: string | null } = {},
): Request {
  return webhookDelivery({
    event: fixture.split(".")[0] as string,
    payload: webhookFixture(fixture),
    secret: options.secret ?? TEST_WEBHOOK_SECRET,
    ...(options.signature === undefined
      ? {}
      : { signature: options.signature }),
  });
}

async function eventOf(
  fixture: string,
  data: FakeGithubAppClientData = {},
): Promise<IntegrationEvent> {
  return setup(data).provider.parseEvent(integration, delivery(fixture));
}

const triggerOf = (event: IntegrationEvent): ReviewTrigger => {
  if (event.kind !== "review_trigger")
    throw new Error(`expected a review trigger, got ${event.kind}`);
  return event.trigger;
};

const commandTrigger: ReviewTrigger = {
  kind: "command",
  repo: widgets,
  prNumber: 7,
  prUrl: "https://github.com/acme/widgets/pull/7",
  headSha: FAKE_PULL_REQUEST.headSha,
  command: "review",
  args: "",
  actor: { login: "bob", externalId: "1002" },
};

describeIntegrationProviderConformance("the GitHub App provider", () => {
  const { provider } = setup();
  return {
    provider,
    integration,
    repo: widgets,
    trigger: commandTrigger,
    signedOpenedDelivery: () => delivery("pull_request.opened"),
    badlySignedDelivery: () =>
      delivery("pull_request.opened", { secret: "another-secret" }),
    tamperedDelivery: () =>
      webhookDelivery({
        event: "pull_request",
        body: JSON.stringify(webhookFixture("pull_request.opened")).replace(
          '"number":7',
          '"number":8',
        ),
        secret: TEST_WEBHOOK_SECRET,
        signature: delivery("pull_request.opened").headers.get(
          "x-hub-signature-256",
        ),
      }),
    irrelevantDelivery: () => delivery("pull_request.labeled"),
    installationRemovedDelivery: () => delivery("installation.deleted"),
    existingPullRequestNumber: 7,
    missingPullRequestNumber: 99,
    validConfig: {
      accountLogin: "acme",
      accountId: 5001,
      accountType: "Organization",
    },
    invalidConfig: { accountLogin: 5 },
  };
});

describe("verifying a delivery", () => {
  it("accepts a delivery signed with the webhook secret", async () => {
    const { provider } = setup();

    expect(
      await provider.verifyWebhook(null, delivery("installation.created")),
    ).toBe(true);
  });

  it("refuses a missing signature, a wrong secret and a signature of another algorithm", async () => {
    const { provider } = setup();

    for (const request of [
      delivery("installation.created", { signature: null }),
      delivery("installation.created", { secret: "other" }),
      delivery("installation.created", { signature: "sha1=abc" }),
      delivery("installation.created", { signature: "sha256=zz" }),
    ])
      expect(await provider.verifyWebhook(null, request)).toBe(false);
  });
});

describe("identifying the installation of a delivery", () => {
  it("returns the installation id for events that carry one", async () => {
    const { provider } = setup();

    for (const fixture of [
      "installation.created",
      "installation_repositories.added",
      "pull_request.opened",
      "issue_comment.created.review",
    ])
      expect(await provider.identifyWebhook(delivery(fixture))).toEqual({
        externalId: "4242",
      });
  });

  it("returns null for a ping and for a body that is not JSON", async () => {
    const { provider } = setup();

    expect(await provider.identifyWebhook(delivery("ping"))).toBeNull();
    expect(
      await provider.identifyWebhook(
        webhookDelivery({ event: "ping", body: "not json", secret: "x" }),
      ),
    ).toBeNull();
  });
});

describe("translating installation deliveries", () => {
  it.each([
    ["installation.created", "created"],
    ["installation.deleted", "deleted"],
    ["installation.suspend", "suspended"],
    ["installation.unsuspend", "unsuspended"],
    ["installation_repositories.added", "repositories_changed"],
    ["installation_repositories.removed", "repositories_changed"],
  ])(
    "reads %s as an installation change of kind %s",
    async (fixture, action) => {
      expect(await eventOf(fixture)).toEqual({
        kind: "installation_changed",
        externalId: "4242",
        action,
      });
    },
  );

  it("ignores a permission change", async () => {
    expect(
      await eventOf("installation.new_permissions_accepted"),
    ).toMatchObject({ kind: "ignored" });
  });
});

describe("translating pull request deliveries", () => {
  it("turns an opened pull request into a trigger with the normalized fields", async () => {
    const trigger = triggerOf(await eventOf("pull_request.opened"));

    expect(trigger).toEqual({
      kind: "opened",
      repo: {
        integrationId: "integration-1",
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.com/acme/widgets",
      },
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
      command: null,
      args: null,
      actor: { login: "alice", externalId: "1001" },
    });
  });

  it("treats reopened and ready for review like opened, and new commits as an update", async () => {
    expect(triggerOf(await eventOf("pull_request.reopened")).kind).toBe(
      "opened",
    );
    expect(triggerOf(await eventOf("pull_request.ready_for_review")).kind).toBe(
      "opened",
    );
    expect(triggerOf(await eventOf("pull_request.synchronize")).kind).toBe(
      "updated",
    );
  });

  it("reviews a pull request from a fork against the repository it targets", async () => {
    const trigger = triggerOf(await eventOf("pull_request.opened.fork"));

    expect(trigger.repo.fullName).toBe("acme/widgets");
    expect(trigger.headSha).toMatch(/^9e8d7c6b/);
  });

  it("ignores actions that do not start a review", async () => {
    expect(await eventOf("pull_request.closed")).toMatchObject({
      kind: "ignored",
    });
    expect(await eventOf("pull_request.labeled")).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("translating comment deliveries", () => {
  it("turns a command comment into a command trigger with the current head commit", async () => {
    const { client, provider } = setup();

    const event = await provider.parseEvent(
      integration,
      delivery("issue_comment.created.review"),
    );

    expect(triggerOf(event)).toMatchObject({
      kind: "command",
      command: "review",
      args: "",
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      headSha: FAKE_PULL_REQUEST.headSha,
      actor: { login: "bob", externalId: "1002" },
    });
    expect(client.calls).toEqual([
      { method: "getPullRequest", args: ["4242", "acme/widgets", 7] },
    ]);
  });

  it("reads the command at the start in any case, with leading whitespace, and keeps the arguments", async () => {
    const trigger = triggerOf(await eventOf("issue_comment.created.ask"));

    expect(trigger).toMatchObject({
      command: "ask",
      args: "what does the cache key contain?\nPlease be brief.",
    });
  });

  it("ignores comments that are no command, were edited or deleted, or are on an issue", async () => {
    for (const fixture of [
      "issue_comment.created.plain",
      "issue_comment.edited.review",
      "issue_comment.deleted.review",
      "issue_comment.created.on-issue",
    ])
      expect(await eventOf(fixture)).toMatchObject({ kind: "ignored" });
  });

  it("ignores commands on a closed pull request and comments written by a bot", async () => {
    expect(await eventOf("issue_comment.created.closed")).toMatchObject({
      kind: "ignored",
    });
    expect(await eventOf("issue_comment.created.bot")).toMatchObject({
      kind: "ignored",
    });
  });

  it("does not ask GitHub anything for a comment that is no command", async () => {
    const { client, provider } = setup();

    await provider.parseEvent(
      integration,
      delivery("issue_comment.created.plain"),
    );

    expect(client.calls).toEqual([]);
  });
});

describe("translating other deliveries", () => {
  it("ignores events the app does not use and payloads of the wrong shape", async () => {
    const { provider } = setup();

    expect(await eventOf("ping")).toMatchObject({ kind: "ignored" });
    expect(
      await provider.parseEvent(
        integration,
        webhookDelivery({
          event: "pull_request",
          payload: { action: "opened" },
          secret: TEST_WEBHOOK_SECRET,
        }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      await provider.parseEvent(
        integration,
        webhookDelivery({ event: "pull_request", body: "{", secret: "x" }),
      ),
    ).toMatchObject({ kind: "ignored" });
  });
});

describe("deciding who may trigger a command", () => {
  it("lets an administrator or a user with write access trigger a command", async () => {
    const { provider } = setup({
      permissions: {
        "acme/widgets#bob": "write",
        "acme/widgets#carol": "admin",
      },
    });

    for (const login of ["bob", "carol"])
      expect(
        await provider.canTrigger(integration, {
          ...commandTrigger,
          actor: { login, externalId: null },
        }),
      ).toBe(true);
  });

  it("refuses a user with read access or no access at all", async () => {
    const { provider } = setup({
      permissions: { "acme/widgets#dave": "read" },
    });

    for (const login of ["dave", "mallory"])
      expect(
        await provider.canTrigger(integration, {
          ...commandTrigger,
          actor: { login, externalId: null },
        }),
      ).toBe(false);
  });

  it("starts reviews of opened and updated pull requests without asking for permissions", async () => {
    const { client, provider } = setup();

    const opened = triggerOf(await eventOf("pull_request.opened.fork"));

    expect(await provider.canTrigger(integration, opened)).toBe(true);
    expect(client.calls).toEqual([]);
  });
});

describe("job access", () => {
  it("returns a token for one repository with a hidden token and the bot login", async () => {
    const { client, provider } = setup();

    const access = await provider.jobAccess(integration, widgets);

    expect(isGitAccess(access)).toBe(true);
    expect(access).toMatchObject({
      provider: "github",
      baseUrl: "https://api.github.com",
      authType: "token",
      botLogin: "code-reviewer-test[bot]",
      expiresAt: "2026-10-10T13:00:00.000Z",
    });
    expect(access.token).toBe("ghs_unit_test_token");
    expect(JSON.stringify(access)).not.toContain("ghs_unit_test_token");
    expect(client.calls).toEqual([
      {
        method: "mintInstallationToken",
        args: ["4242", { repositoryNames: ["widgets"] }],
      },
    ]);
  });
});

describe("pull requests", () => {
  it("lists the open pull requests of a repository", async () => {
    const { provider } = setup();

    expect(await provider.listOpenPullRequests(integration, widgets)).toEqual([
      FAKE_PULL_REQUEST,
    ]);
  });
});

describe("a missing configuration", () => {
  it("fails the first call that needs GitHub with a config error and works once the settings are valid", async () => {
    let configured = false;
    const provider = createGithubAppProvider({
      config: () => {
        if (!configured)
          throw new GithubAppConfigError(["GITHUB_APP_ID"], "missing");
        return testGithubAppConfig();
      },
      client: fakeGithubAppClient(),
    });

    await expect(provider.listRepositories(integration)).rejects.toMatchObject({
      code: "GITHUB_APP_CONFIG_INVALID",
    });
    expect(provider.validateConfig({}).ok).toBe(false);

    configured = true;
    expect(await provider.listRepositories(integration)).toHaveLength(1);
  });
});
