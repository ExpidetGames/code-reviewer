// Pins down the GitHub webhook payload subset that Code Reviewer reads: every recorded payload in
// fakes/fixtures/github-webhooks has all the fields the parser lists as read (installation id,
// repository id and full name, sender, pull request head, comment text) with the right types, and
// the provider takes the values over correctly. (It lives in the provider's folder because only that
// folder may import a provider.) If GitHub changes a payload, or a fixture loses a
// field, this fails before a delivery is misread in production.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../../../fakes/github/webhooks.ts";
import { parseGithubEvent } from "./events.ts";
import {
  isReadWebhookEvent,
  payloadProblems,
  WEBHOOK_READ_FIELDS,
} from "./webhook-fields.ts";
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../../../test-support/github-app.ts";
import { createGithubAppProvider } from "./provider.ts";
import { fakeGithubAppClient } from "./fake-client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";

const testGithubAppConfig = (
  overrides: Record<string, string | undefined> = {},
) => loadGithubAppConfig(testGithubAppEnv(overrides));

/** A recorded payload as far as these tests reach into it. */
type Damageable = {
  pull_request: {
    head: { sha?: string };
    draft: unknown;
    state: unknown;
    merged?: boolean;
  };
  installation?: unknown;
};

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../fakes/fixtures/github-webhooks",
);
const fixtureNames = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""));

const integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});

describe("the recorded GitHub webhook payloads", () => {
  it("cover every event the app reads", () => {
    const covered = new Set(fixtureNames.map((name) => name.split(".")[0]));

    for (const event of Object.keys(WEBHOOK_READ_FIELDS))
      expect(covered, event).toContain(event);
  });

  // CR-21-T14
  it.each(
    fixtureNames.filter((name) =>
      isReadWebhookEvent(name.split(".")[0] as string),
    ),
  )("%s has every field the parser reads, with the right type", (name) => {
    const event = name.split(".")[0] as keyof typeof WEBHOOK_READ_FIELDS;

    expect(payloadProblems(event, webhookFixture(name))).toEqual([]);
  });

  // CR-31-T18
  it.each([
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.closed",
  ])(
    "%s has every field the automatic reviews read, with the right type",
    (name) => {
      const payload = webhookFixture(name) as Record<string, unknown> & {
        action: string;
        number: number;
        pull_request: {
          draft: boolean;
          state: string;
          merged: boolean;
          head: { sha: string };
        };
        repository: { id: number; full_name: string };
        installation: { id: number };
      };

      // The parser is held to the same list: a field it reads must be listed, so a payload without
      // one of these is invalid, and so is a fixture whose schema drifted.
      const listed = WEBHOOK_READ_FIELDS.pull_request.map((spec) => spec.path);
      for (const path of [
        "action",
        "number",
        "pull_request.draft",
        "pull_request.state",
        "pull_request.merged",
        "pull_request.head.sha",
        "repository.id",
        "installation.id",
      ])
        expect(listed, path).toContain(path);
      expect(payloadProblems("pull_request", payload)).toEqual([]);
      expect(typeof payload.action).toBe("string");
      expect(Number.isInteger(payload.number)).toBe(true);
      expect(typeof payload.pull_request.draft).toBe("boolean");
      expect(["open", "closed"]).toContain(payload.pull_request.state);
      expect(typeof payload.pull_request.merged).toBe("boolean");
      expect(payload.pull_request.head.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof payload.repository.id).toBe("number");
      expect(typeof payload.repository.full_name).toBe("string");
      expect(Number.isInteger(payload.installation.id)).toBe(true);
    },
  );

  it.each([
    [
      "pull_request.head.sha",
      (p: Damageable) => delete p.pull_request.head.sha,
    ],
    ["pull_request.draft", (p: Damageable) => (p.pull_request.draft = "false")],
    ["pull_request.merged", (p: Damageable) => delete p.pull_request.merged],
    ["pull_request.state", (p: Damageable) => (p.pull_request.state = 1)],
    ["installation.id", (p: Damageable) => delete p.installation],
  ])("reports a payload whose %s drifted", (path, damage) => {
    const payload = webhookFixture("pull_request.opened");

    damage(payload as unknown as Damageable);

    expect(payloadProblems("pull_request", payload)).toContain(path);
  });

  // CR-21-T14
  it("are taken over correctly for installation and repository changes", async () => {
    const provider = createGithubAppProvider({
      config: testGithubAppConfig(),
      client: fakeGithubAppClient(),
    });
    const read = async (name: string) =>
      provider.parseEvent(
        integration,
        webhookDelivery({
          event: name.split(".")[0] as string,
          payload: webhookFixture(name),
          secret: TEST_WEBHOOK_SECRET,
        }),
      );

    expect(await read("installation.created")).toEqual({
      kind: "installation_changed",
      externalId: "4242",
      action: "created",
    });
    expect(await read("installation.deleted")).toMatchObject({
      action: "deleted",
    });
    expect(await read("installation_repositories.added")).toMatchObject({
      externalId: "4242",
      action: "repositories_changed",
    });
    expect(await read("installation_repositories.removed")).toMatchObject({
      externalId: "4242",
      action: "repositories_changed",
    });
  });

  // CR-21-T14
  it("name the repository of a pull request by id and full name", async () => {
    const event = await parseGithubEvent({
      integrationId: "integration-1",
      eventName: "pull_request",
      payload: webhookFixture("pull_request.opened"),
      hasWriteAccess: async () => false,
      headShaOf: async () => "unused",
    });

    expect(event).toMatchObject({
      kind: "review_trigger",
      trigger: {
        repo: { externalId: "7001", fullName: "acme/widgets" },
        actor: { login: "alice", externalId: "1001" },
      },
    });
  });

  // CR-22-T15
  it.each([
    ["pull_request.opened", "opened", "alice", "1f3a5c7e"],
    ["pull_request.synchronize", "updated", "alice", "1f3a5c7e"],
    ["pull_request.reopened", "opened", "alice", "1f3a5c7e"],
    ["pull_request.ready_for_review", "opened", "alice", "1f3a5c7e"],
    ["pull_request.opened.draft", "opened", "alice", "1f3a5c7e"],
    ["pull_request.opened.fork", "opened", "alice", "9e8d7c6b"],
  ])(
    "%s is translated into the expected review trigger",
    async (name, kind, login, headPrefix) => {
      const provider = createGithubAppProvider({
        config: testGithubAppConfig(),
        client: fakeGithubAppClient(),
      });

      const event = await provider.parseEvent(
        integration,
        webhookDelivery({
          event: "pull_request",
          payload: webhookFixture(name),
          secret: TEST_WEBHOOK_SECRET,
        }),
      );

      expect(event).toMatchObject({
        kind: "review_trigger",
        trigger: {
          kind,
          repo: { fullName: "acme/widgets", integrationId: "integration-1" },
          prNumber: 7,
          prUrl: "https://github.com/acme/widgets/pull/7",
          command: null,
          actor: { login },
        },
      });
      if (event.kind !== "review_trigger") throw new Error("unreachable");
      expect(event.trigger.headSha.startsWith(headPrefix)).toBe(true);
    },
  );

  // CR-22-T15
  it.each(["pull_request.edited", "pull_request.labeled", "push", "ping"])(
    "%s is deliberately translated into no trigger",
    async (name) => {
      const provider = createGithubAppProvider({
        config: testGithubAppConfig(),
        client: fakeGithubAppClient(),
      });

      const event = await provider.parseEvent(
        integration,
        webhookDelivery({
          event: name.split(".")[0] as string,
          payload: webhookFixture(name),
          secret: TEST_WEBHOOK_SECRET,
        }),
      );

      expect(event.kind).toBe("ignored");
    },
  );
});
