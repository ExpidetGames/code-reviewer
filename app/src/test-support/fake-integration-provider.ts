// A stand-in for a real integration provider, so that jobs, the runner API and the UI can be built
// and tested without GitHub. It speaks a small made-up "platform format" in its webhooks (see
// `fakeWebhookRequest`) and translates it into the normalized types, exactly like a real provider.
import {
  validateConfigAgainstSchema,
  type ConfigSchema,
} from "../integrations/config-schema.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type {
  GitAccess,
  Integration,
  RepoRef,
  ReviewTrigger,
} from "../integrations/types.ts";

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

const FAKE_CONFIG_SCHEMA: ConfigSchema = {
  accountLogin: { type: "string" },
  accountId: { type: "number" },
};

export type FakeRepo = { id: string; fullName: string };

export type FakeIntegrationProviderOptions = {
  repos?: FakeRepo[];
  webhookSecret?: string;
  /** Logins that may trigger a review; everyone may when omitted. */
  allowedActors?: string[];
  access?: Partial<GitAccess>;
  /** Makes `jobAccess` fail with this error (platform down, installation removed, ...). */
  jobAccessFailure?: Error;
};

export type FakeProviderCall = { method: string; args: unknown[] };

export type FakeIntegrationProvider = IntegrationProvider & {
  /** Every call, in order, for assertions. */
  readonly calls: FakeProviderCall[];
};

/** The made-up platform event the fake provider understands. */
export type FakeWebhookEvent = {
  action: "opened" | "synchronize" | "comment" | "closed";
  repository: { id: string; full_name: string };
  number: number;
  head: { sha: string };
  sender: { login: string; id: string };
  comment?: { body: string };
};

export function fakeWebhookRequest(
  event: FakeWebhookEvent,
  options: { secret?: string } = {},
): Request {
  return new Request("https://app.test/api/webhooks/github_app", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [FAKE_SIGNATURE_HEADER]: options.secret ?? FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(event),
  });
}

export function fakeIntegration(
  overrides: Partial<Integration> = {},
): Integration {
  return {
    id: "integration-1",
    type: "github_app",
    displayName: "Fake integration",
    externalId: "installation-1",
    config: { accountLogin: "acme", accountId: 5 },
    credentials: null,
    webhookSecret: null,
    status: "active",
    createdAt: "2026-10-10T08:00:00.000Z",
    updatedAt: "2026-10-10T08:00:00.000Z",
    ...overrides,
  };
}

const COMMAND_PATTERN = /^\s*\/(review|improve|describe|ask)\b\s*([\s\S]*)$/i;

export function fakeIntegrationProvider(
  options: FakeIntegrationProviderOptions = {},
): FakeIntegrationProvider {
  const repos = options.repos ?? [
    { id: "100", fullName: "acme/widgets" },
    { id: "101", fullName: "acme/gadgets" },
  ];
  const secret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
  const calls: FakeProviderCall[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });

  const toRepoRef = (integrationId: string, repo: FakeRepo): RepoRef => ({
    integrationId,
    externalId: repo.id,
    fullName: repo.fullName,
    url: `https://fake.test/${repo.fullName}`,
  });

  return {
    calls,
    type: "github_app",
    connect: { kind: "install_redirect" },

    validateConfig(config) {
      record("validateConfig", config);
      return validateConfigAgainstSchema(FAKE_CONFIG_SCHEMA, config);
    },

    async listRepositories(integration) {
      record("listRepositories", integration);
      return repos.map((repo) => toRepoRef(integration.id, repo));
    },

    async verifyWebhook(integration, request) {
      record("verifyWebhook", integration, request);
      return request.headers.get(FAKE_SIGNATURE_HEADER) === secret;
    },

    async parseEvent(integration, request) {
      record("parseEvent", integration, request);
      const event = (await request.clone().json()) as FakeWebhookEvent;
      const base = {
        repo: toRepoRef(integration.id, {
          id: event.repository.id,
          fullName: event.repository.full_name,
        }),
        prNumber: event.number,
        headSha: event.head.sha,
        actor: { login: event.sender.login, externalId: event.sender.id },
      };

      if (event.action === "opened")
        return { ...base, kind: "opened", command: null, args: null };
      if (event.action === "synchronize")
        return { ...base, kind: "updated", command: null, args: null };
      if (event.action === "comment") {
        const match = COMMAND_PATTERN.exec(event.comment?.body ?? "");
        if (match === null) return null;
        return {
          ...base,
          kind: "command",
          command: match[1]!.toLowerCase() as "review",
          args: (match[2] ?? "").trim(),
        };
      }
      return null;
    },

    async canTrigger(integration, trigger: ReviewTrigger) {
      record("canTrigger", integration, trigger);
      if (options.allowedActors === undefined) return true;
      return options.allowedActors.includes(trigger.actor.login);
    },

    async jobAccess(integration, repo) {
      record("jobAccess", integration, repo);
      if (options.jobAccessFailure) throw options.jobAccessFailure;
      return {
        provider: "github",
        baseUrl: "https://fake.test/api",
        token: `fake-token-for-${repo.fullName}`,
        authType: "token",
        botLogin: "fake-reviewer[bot]",
        expiresAt: "2026-10-10T13:00:00.000Z",
        ...options.access,
      };
    },
  };
}
