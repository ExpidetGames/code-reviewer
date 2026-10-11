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
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../../../test-support/github-app.ts";
import {
  FAKE_PULL_REQUEST,
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { isGitAccess } from "../../normalized.ts";
import type {
  Integration,
  IntegrationEvent,
  RepoRef,
  ReviewTrigger,
} from "../../types.ts";
import { GithubAppConfigError, GithubAppError } from "./errors.ts";
import { createGithubAppProvider } from "./provider.ts";

const testGithubAppConfig = (
  overrides: Record<string, string | undefined> = {},
) => loadGithubAppConfig(testGithubAppEnv(overrides));

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
  const client = fakeGithubAppClient({
    // The commenter of the fixtures has write access unless a test says otherwise.
    permissions: { "acme/widgets#bob": "write" },
    ...data,
  });
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
  commentId: "99001",
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

  // CR-21-T14
  it("refuses a delivery whose body was changed after it was signed", async () => {
    const { provider } = setup();
    const original = JSON.stringify(webhookFixture("pull_request.opened"));
    const signature = delivery("pull_request.opened").headers.get(
      "x-hub-signature-256",
    );

    const tampered = webhookDelivery({
      event: "pull_request",
      body: original.replace('"number":7', '"number":8'),
      secret: TEST_WEBHOOK_SECRET,
      signature,
    });

    expect(await provider.verifyWebhook(null, tampered)).toBe(false);
    expect(
      await provider.verifyWebhook(
        null,
        webhookDelivery({
          event: "pull_request",
          body: original,
          secret: TEST_WEBHOOK_SECRET,
          signature,
        }),
      ),
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
      draft: false,
      state: "open",
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

  it("ignores actions that do not start a review, and reports a closed pull request as such", async () => {
    expect(await eventOf("pull_request.closed")).toMatchObject({
      kind: "pull_request_closed",
      prNumber: 7,
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
      commentId: "99001",
    });
    expect(client.calls).toEqual([
      {
        method: "getCollaboratorPermission",
        args: ["4242", "acme/widgets", "bob"],
      },
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

  // CR-32-T02
  it("cuts a long question and passes no text on with a command other than /ask", async () => {
    const withBody = async (body: string) => {
      const payload = webhookFixture("issue_comment.created.review");
      (payload.comment as { body: string }).body = body;
      return setup().provider.parseEvent(
        integration,
        webhookDelivery({
          event: "issue_comment",
          payload,
          secret: TEST_WEBHOOK_SECRET,
        }),
      );
    };

    expect(triggerOf(await withBody("/ask " + "q".repeat(3000)))).toMatchObject(
      { command: "ask", args: expect.stringContaining("was cut here") },
    );
    expect(
      triggerOf(await withBody("/review --pr_reviewer.num_max_findings=99")),
    ).toMatchObject({ command: "review", args: "" });
  });

  // CR-32-T05
  it("ignores /ask without a question and commands it does not know, and asks GitHub nothing", async () => {
    const { client, provider } = setup();
    for (const body of ["/ask", "/deploy now"]) {
      const payload = webhookFixture("issue_comment.created.review");
      (payload.comment as { body: string }).body = body;

      const event = await provider.parseEvent(
        integration,
        webhookDelivery({
          event: "issue_comment",
          payload,
          secret: TEST_WEBHOOK_SECRET,
        }),
      );

      expect(event).toMatchObject({ kind: "ignored" });
    }
    expect(client.calls).toEqual([]);
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

  it("ignores commands on a closed pull request", async () => {
    expect(await eventOf("issue_comment.created.closed")).toMatchObject({
      kind: "ignored",
    });
  });

  // CR-32-T10
  it("ignores a comment written by a bot even when the bot has write access", async () => {
    const { client, provider } = setup({
      permissions: {
        "acme/widgets#bob": "write",
        "acme/widgets#code-reviewer-test[bot]": "write",
      },
    });

    const event = await provider.parseEvent(
      integration,
      delivery("issue_comment.created.bot"),
    );

    expect(event).toMatchObject({ kind: "ignored" });
    // The type of the sender stops it before anybody asks GitHub about the bot.
    expect(client.calls).toEqual([]);
  });

  it("asks GitHub nothing for a commenter who cannot have write access", async () => {
    const { client, provider } = setup();

    const event = await provider.parseEvent(
      integration,
      delivery("issue_comment.created.outsider"),
    );

    expect(event).toMatchObject({ kind: "ignored" });
    expect(client.calls).toEqual([]);
  });

  it("does not read the pull request for a member who has no write access", async () => {
    const { client, provider } = setup({
      permissions: { "acme/widgets#bob": "read" },
    });

    const event = await provider.parseEvent(
      integration,
      delivery("issue_comment.created.review"),
    );

    expect(event).toMatchObject({ kind: "ignored" });
    expect(client.calls.map((call) => call.method)).toEqual([
      "getCollaboratorPermission",
    ]);
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
  it("ignores events the app does not use and calls payloads of the wrong shape invalid", async () => {
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
    ).toMatchObject({ kind: "invalid_payload" });
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
        args: [
          "4242",
          {
            repositoryIds: [7001],
            permissions: {
              pull_requests: "write",
              issues: "write",
              contents: "read",
              metadata: "read",
            },
          },
        ],
      },
    ]);
  });

  // CR-23-T13
  it.each([
    ["code-reviewer", undefined, "https://api.github.com"],
    ["cr-2-bot3", undefined, "https://api.github.com"],
    ["a1", "http://127.0.0.1:9999/api/v3/", "http://127.0.0.1:9999/api/v3"],
  ])(
    "builds the bot login from the slug %s and takes the base URL from the settings (%s)",
    async (slug, baseUrl, expectedBaseUrl) => {
      const provider = createGithubAppProvider({
        config: testGithubAppConfig({
          GITHUB_APP_SLUG: slug,
          GITHUB_API_BASE_URL: baseUrl,
          ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        }),
        client: fakeGithubAppClient(),
      });

      const access = await provider.jobAccess(integration, widgets);

      expect(access.botLogin).toBe(`${slug}[bot]`);
      expect(access.baseUrl).toBe(expectedBaseUrl);
    },
  );

  it("puts the expiry of the token into the access and keeps it out of the token", async () => {
    const { provider } = setup({
      token: { token: "ghs_x", expiresAt: "2026-10-10T12:30:00.000Z" },
    });

    expect((await provider.jobAccess(integration, widgets)).expiresAt).toBe(
      "2026-10-10T12:30:00.000Z",
    );
  });

  it("turns an unexpected failure into a coded error that carries no message of the original", async () => {
    const { provider } = setup({
      mintFailure: new Error("boom with ghs_secret inside"),
    });

    const error = await provider.jobAccess(integration, widgets).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ code: "INTEGRATION_ACCESS_FAILED" });
    expect((error as Error).message).not.toContain("ghs_secret");
  });

  it("passes a configuration error on as a coded access failure that names the variables", async () => {
    const provider = createGithubAppProvider({
      config: () => {
        throw new GithubAppConfigError(["GITHUB_APP_ID"], "missing");
      },
      client: fakeGithubAppClient(),
    });

    await expect(
      provider.jobAccess(integration, widgets),
    ).rejects.toMatchObject({
      code: "INTEGRATION_ACCESS_FAILED",
      message: expect.stringContaining("GITHUB_APP_ID"),
    });
  });
});

describe("pull requests", () => {
  it("lists the open pull requests of a repository", async () => {
    const { provider } = setup();

    expect(await provider.listOpenPullRequests(integration, widgets)).toEqual([
      FAKE_PULL_REQUEST,
    ]);
  });

  it("hands the abort signal of the caller to the client when reading one pull request", async () => {
    const { provider, client } = setup();
    const signal = new AbortController().signal;

    await provider.getPullRequest(integration, widgets, 7, signal);

    expect(client.calls).toEqual([
      { method: "getPullRequest", args: ["4242", "acme/widgets", 7, signal] },
    ]);
  });

  it("hands the abort signal of the caller to the client when listing the open pull requests", async () => {
    const { provider, client } = setup();
    const signal = new AbortController().signal;

    await provider.listOpenPullRequests(integration, widgets, signal);

    expect(client.calls).toEqual([
      {
        method: "listOpenPullRequests",
        args: ["4242", "acme/widgets", signal],
      },
    ]);
  });
});

describe("listing the open pull requests when GitHub refuses", () => {
  it.each([
    [
      new GithubAppError("GITHUB_APP_NOT_FOUND", "gone", { status: 404 }),
      "INTEGRATION_ACCESS_CONNECTION_GONE",
      false,
    ],
    [
      new GithubAppError("GITHUB_APP_FORBIDDEN", "refused", { status: 403 }),
      "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
      false,
    ],
    [
      new GithubAppError("GITHUB_APP_AUTH_FAILED", "no", { status: 401 }),
      "INTEGRATION_ACCESS_APP_AUTH_FAILED",
      false,
    ],
    [
      new GithubAppError("GITHUB_APP_UNAVAILABLE", "down", { status: 500 }),
      "INTEGRATION_ACCESS_UNAVAILABLE",
      true,
    ],
    [
      new GithubAppError("GITHUB_APP_RATE_LIMITED", "slow down", {
        status: 429,
      }),
      "INTEGRATION_ACCESS_RATE_LIMITED",
      true,
    ],
    [
      // A refused request of another kind is not "the app has no access".
      new GithubAppError("GITHUB_APP_REQUEST_FAILED", "unprocessable", {
        status: 422,
      }),
      "INTEGRATION_ACCESS_FAILED",
      false,
    ],
  ] as const)(
    "reports %s as the provider neutral code %s",
    async (failure, code, retryable) => {
      const { provider } = setup({ listPullRequestsFailure: failure });

      await expect(
        provider.listOpenPullRequests(integration, widgets),
      ).rejects.toMatchObject({ name: "IntegrationError", code, retryable });
    },
  );

  it("does not put anything but the client's own message into the failure", async () => {
    const { provider } = setup({
      listPullRequestsFailure: new Error("response body with ghs_secret"),
    });

    const error = await provider
      .listOpenPullRequests(integration, widgets)
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_FAILED",
      message: "GitHub could not be asked.",
    });
    expect((error as Error).message).not.toContain("ghs_secret");
  });
});

describe("fetching one pull request when GitHub refuses", () => {
  it("reports a 404 of the call as an unknown pull request", async () => {
    const { provider } = setup();

    await expect(
      provider.getPullRequest(integration, widgets, 99),
    ).rejects.toMatchObject({ code: "INTEGRATION_PULL_REQUEST_NOT_FOUND" });
  });

  it("reports a 404 of the token request as an installation that is gone, not as an unknown pull request", async () => {
    const { provider } = setup({
      getPullRequestFailure: new GithubAppError(
        "GITHUB_APP_NOT_FOUND",
        "gone",
        {
          status: 404,
          duringTokenRequest: true,
        },
      ),
    });

    await expect(
      provider.getPullRequest(integration, widgets, 7),
    ).rejects.toMatchObject({ code: "INTEGRATION_ACCESS_CONNECTION_GONE" });
  });

  it.each([
    [
      new GithubAppError("GITHUB_APP_AUTH_FAILED", "no", { status: 401 }),
      "INTEGRATION_ACCESS_APP_AUTH_FAILED",
    ],
    [
      new GithubAppError("GITHUB_APP_FORBIDDEN", "refused", { status: 403 }),
      "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
    ],
    [
      new GithubAppError("GITHUB_APP_UNAVAILABLE", "down", { status: 500 }),
      "INTEGRATION_ACCESS_UNAVAILABLE",
    ],
  ] as const)(
    "reports %s as the provider neutral code %s",
    async (failure, code) => {
      const { provider } = setup({ getPullRequestFailure: failure });

      await expect(
        provider.getPullRequest(integration, widgets, 7),
      ).rejects.toMatchObject({ name: "IntegrationError", code });
    },
  );
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
