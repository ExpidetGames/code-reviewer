// Pins down the fake provider that other tickets build on, and the conformance suite itself: the
// fake must pass it, and a provider that leaks a raw platform format must fail it.
import { describe, expect, it } from "vitest";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { RepoRef, ReviewTrigger } from "../integrations/types.ts";
import {
  fakeIntegration,
  fakeIntegrationProvider,
  fakeWebhookRequest,
  type FakeWebhookEvent,
} from "./fake-integration-provider.ts";
import {
  CONFORMANCE_CHECKS,
  describeIntegrationProviderConformance,
  integrationProviderViolations,
  type ConformanceSubject,
} from "./integration-provider-conformance.ts";

const openedEvent: FakeWebhookEvent = {
  action: "opened",
  repository: { id: "100", full_name: "acme/widgets" },
  number: 7,
  head: { sha: "abc123" },
  sender: { login: "alice", id: "1" },
};

function createSubject(provider: IntegrationProvider): ConformanceSubject {
  const integration = fakeIntegration();
  const repo: RepoRef = {
    integrationId: integration.id,
    externalId: "100",
    fullName: "acme/widgets",
    url: "https://fake.test/acme/widgets",
  };
  const trigger: ReviewTrigger = {
    kind: "opened",
    repo,
    prNumber: 7,
    headSha: "abc123",
    command: null,
    args: null,
    actor: { login: "alice", externalId: "1" },
  };
  return {
    provider,
    integration,
    repo,
    trigger,
    signedOpenedDelivery: () => fakeWebhookRequest(openedEvent),
    badlySignedDelivery: () =>
      fakeWebhookRequest(openedEvent, { secret: "wrong" }),
    irrelevantDelivery: () =>
      fakeWebhookRequest({ ...openedEvent, action: "closed" }),
    validConfig: { accountLogin: "acme", accountId: 5 },
    invalidConfig: { accountId: "five" },
  };
}

// CR-20-T01
describeIntegrationProviderConformance("the fake provider", () =>
  createSubject(fakeIntegrationProvider()),
);

describe("the conformance suite", () => {
  // CR-20-T01
  it("fails a provider that hands out the platform's raw payload instead of normalized types", async () => {
    const fake = fakeIntegrationProvider();
    const leaky: IntegrationProvider = {
      ...fake,
      listRepositories: async () =>
        [{ id: 100, full_name: "acme/widgets", node_id: "MDEw" }] as never,
      parseEvent: async (_integration, request) =>
        (await request.clone().json()) as never,
      jobAccess: async () => ({ token: "t", installation: { id: 9 } }) as never,
    };
    const subject = createSubject(leaky);

    const results = await Promise.all(
      CONFORMANCE_CHECKS.map((check) =>
        integrationProviderViolations(check, subject),
      ),
    );

    const failed = CONFORMANCE_CHECKS.filter(
      (_, index) => results[index]!.length > 0,
    );
    expect(failed).toEqual([
      "lists repositories as repo references of its integration",
      "turns a delivery into a normalized review trigger",
      "returns null for a delivery that is not relevant",
      "hands out job access as normalized git access",
    ]);
  });
});

describe("the fake integration provider", () => {
  it("turns a synchronize delivery into an updated trigger", async () => {
    const provider = fakeIntegrationProvider();

    const trigger = await provider.parseEvent(
      fakeIntegration(),
      fakeWebhookRequest({ ...openedEvent, action: "synchronize" }),
    );

    expect(trigger).toMatchObject({
      kind: "updated",
      prNumber: 7,
      headSha: "abc123",
    });
  });

  it("turns a comment that starts with a command into a command trigger with its arguments", async () => {
    const provider = fakeIntegrationProvider();

    const trigger = await provider.parseEvent(
      fakeIntegration(),
      fakeWebhookRequest({
        ...openedEvent,
        action: "comment",
        comment: { body: "/ask why is this slow?" },
      }),
    );

    expect(trigger).toMatchObject({
      kind: "command",
      command: "ask",
      args: "why is this slow?",
    });
  });

  it("ignores a comment that is not a command", async () => {
    const provider = fakeIntegrationProvider();

    const trigger = await provider.parseEvent(
      fakeIntegration(),
      fakeWebhookRequest({
        ...openedEvent,
        action: "comment",
        comment: { body: "looks good" },
      }),
    );

    expect(trigger).toBeNull();
  });

  it("lets the test decide who may trigger a review", async () => {
    const provider = fakeIntegrationProvider({ allowedActors: ["alice"] });
    const integration = fakeIntegration();
    const trigger = (login: string) =>
      provider.parseEvent(
        integration,
        fakeWebhookRequest({ ...openedEvent, sender: { login, id: "9" } }),
      );

    expect(
      await provider.canTrigger(integration, (await trigger("alice"))!),
    ).toBe(true);
    expect(
      await provider.canTrigger(integration, (await trigger("mallory"))!),
    ).toBe(false);
  });

  it("can be told to fail when job access is requested", async () => {
    const provider = fakeIntegrationProvider({
      jobAccessFailure: new Error("installation removed"),
    });
    const integration = fakeIntegration();

    await expect(
      provider.jobAccess(integration, {
        integrationId: integration.id,
        externalId: "100",
        fullName: "acme/widgets",
        url: "https://fake.test/acme/widgets",
      }),
    ).rejects.toThrow("installation removed");
  });

  it("records the calls it receives", async () => {
    const provider = fakeIntegrationProvider();
    const integration = fakeIntegration();

    await provider.listRepositories(integration);

    expect(provider.calls.map((call) => call.method)).toEqual([
      "listRepositories",
    ]);
  });
});
