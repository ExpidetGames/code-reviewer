// Pins down what the GitHub App webhook route does with a delivery, through the real handler with
// the real GitHub App provider, a real SQLite file and the fake GitHub API: refusals happen before
// anything else, every accepted delivery is remembered by its id, a failure makes the delivery
// retryable, and the response and the logs never carry a secret or a signature.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  signWebhookBody,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import {
  startWebhookHarness,
  type WebhookHarness,
} from "../../src/test-support/webhook-harness.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "../../src/webhooks/github-app-handler.ts";

const OPENED_HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const NEW_HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

type PullRequestPayload = { pull_request: { head: { sha: string } } };

function withHeadSha(fixture: string, sha: string): PullRequestPayload {
  const payload = webhookFixture(fixture) as unknown as PullRequestPayload;
  payload.pull_request.head.sha = sha;
  return payload;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function addOpenPullRequest(h: WebhookHarness) {
  h.fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: OPENED_HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
}

describe("a pull request delivery", () => {
  // CR-22-T01
  it("hands one review trigger for the head commit to the intake and answers 202", async () => {
    const h = await startWebhookHarness();
    const integration = await h.seedInstallation();

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      status: "accepted",
      outcome: "trigger_enqueued",
    });
    expect(h.intake.triggers).toHaveLength(1);
    expect(h.intake.triggers[0]).toMatchObject({
      kind: "opened",
      repo: { fullName: "acme/widgets", integrationId: integration.id },
      prNumber: 7,
      headSha: OPENED_HEAD,
    });
    expect(h.intake.integrations[0]).toMatchObject({ id: integration.id });
    expect(
      (await h.snapshotTables()).deliveries.map((row) => row.outcome),
    ).toEqual(["trigger_enqueued"]);
  });

  // CR-22-T02
  it("hands a second trigger for the new head commit over when the pull request is updated", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    await h.deliver("pull_request.opened");

    const response = await h.deliver("pull_request.synchronize", {
      payload: withHeadSha("pull_request.synchronize", NEW_HEAD),
    });

    expect(response.status).toBe(202);
    expect(h.intake.triggers.map((t) => [t.kind, t.headSha])).toEqual([
      ["opened", OPENED_HEAD],
      ["updated", NEW_HEAD],
    ]);
  });

  it("reviews a pull request from a fork like any other", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    const response = await h.deliver("pull_request.opened.fork");

    expect(response.status).toBe(202);
    expect(h.intake.triggers).toHaveLength(1);
    expect(h.intake.triggers[0]).toMatchObject({
      repo: { fullName: "acme/widgets" },
    });
  });

  it("accepts a delivery for an action that starts no review without handing anything over", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    const response = await h.deliver("pull_request.closed");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ outcome: "ignored" });
    expect(h.intake.calls).toBe(0);
  });

  it("does not hand a trigger over when the platform says the actor may not start a review", async () => {
    const h = await startWebhookHarness({
      wrapProvider: (provider) => ({
        ...provider,
        canTrigger: async () => false,
      }),
    });
    await h.seedInstallation();

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      outcome: "trigger_not_allowed",
    });
    expect(h.intake.calls).toBe(0);
  });

  it("reviews nothing for an installation that is suspended or removed, and asks GitHub nothing", async () => {
    const h = await startWebhookHarness();
    const integration = await h.seedInstallation();
    await h.integrations.setStatus(integration.id, "disabled");
    const before = h.fake.requests().length;

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      outcome: "integration_disabled",
    });
    expect(h.intake.calls).toBe(0);
    expect(h.fake.requests()).toHaveLength(before);
  });

  it("reviews nothing for an installation it does not know and asks GitHub nothing", async () => {
    const h = await startWebhookHarness();
    h.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      outcome: "unknown_installation",
    });
    expect(h.intake.calls).toBe(0);
    expect(h.fake.requests()).toHaveLength(0);
    expect((await h.snapshotTables()).integrations).toEqual([]);
  });
});

describe("a comment delivery", () => {
  it("hands a command trigger with the current head commit over for a commenter with write access", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    const response = await h.deliver("issue_comment.created.review");

    expect(response.status).toBe(202);
    expect(h.intake.triggers).toHaveLength(1);
    expect(h.intake.triggers[0]).toMatchObject({
      kind: "command",
      command: "review",
      prNumber: 7,
      headSha: OPENED_HEAD,
      actor: { login: "bob" },
    });
  });

  it("hands nothing over for a commenter without write access", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "read");

    const response = await h.deliver("issue_comment.created.review");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ outcome: "ignored" });
    expect(h.intake.calls).toBe(0);
  });

  it("hands nothing over for a comment that is no command, and asks GitHub nothing", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const before = h.fake.requests().length;

    const response = await h.deliver("issue_comment.created.plain");

    expect(response.status).toBe(202);
    expect(h.intake.calls).toBe(0);
    expect(h.fake.requests()).toHaveLength(before);
  });
});

describe("a delivery about the installation", () => {
  it("creates the integration of an unknown installation after GitHub confirmed it, and never hands a trigger over", async () => {
    const h = await startWebhookHarness();
    h.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const response = await h.deliver("installation.created");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      outcome: "installation_changed",
    });
    const integration = await h.integrations.findByExternalId(
      "github_app",
      "4242",
    );
    expect(integration).toMatchObject({
      displayName: "acme",
      status: "active",
    });
    expect(
      (await h.repositories.list()).map((repo) => [repo.fullName, repo.active]),
    ).toEqual([["acme/widgets", true]]);
    expect(h.intake.calls).toBe(0);
  });

  it("does not create an integration for an installation GitHub does not know", async () => {
    const h = await startWebhookHarness();

    const response = await h.deliver("installation.created");

    expect(response.status).toBe(202);
    expect((await h.snapshotTables()).integrations).toEqual([]);
  });

  it("disables the integration when the installation is deleted, and reviews nothing afterwards", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    await h.deliver("installation.deleted");
    const response = await h.deliver("pull_request.opened");

    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("disabled");
    expect(await json(response)).toMatchObject({
      outcome: "integration_disabled",
    });
    expect(h.intake.calls).toBe(0);
  });

  it("reads the repositories again when some were added", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    h.fake.addRepository(4242, { id: 7002, fullName: "acme/gadgets" });

    const response = await h.deliver("installation_repositories.added");

    expect(response.status).toBe(202);
    expect(
      (await h.repositories.list()).map((repo) => repo.fullName).sort(),
    ).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  // CR-22-T13
  it("answers 503 and forgets the delivery when GitHub cannot be asked, so the redelivery is handled", async () => {
    const h = await startWebhookHarness();
    h.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    h.fake.fail({ pathIncludes: "/app/installations", status: 503, times: 1 });

    const failed = await h.deliver("installation.created", {
      deliveryId: "delivery-sync",
    });

    expect(failed.status).toBe(503);
    expect(await json(failed)).toEqual({ error: "WEBHOOK_PROCESSING_FAILED" });
    expect((await h.snapshotTables()).deliveries).toEqual([]);
    expect((await h.snapshotTables()).integrations).toEqual([]);

    const retried = await h.deliver("installation.created", {
      deliveryId: "delivery-sync",
    });

    expect(retried.status).toBe(202);
    expect((await h.snapshotTables()).integrations).toHaveLength(1);
  });
});

describe("a delivery with an invalid signature", () => {
  // CR-22-T03
  it("is refused with 401 and changes nothing, and the answer does not repeat the body", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const tables = await h.snapshotTables();
    const requests = h.fake.requests().length;

    const response = await h.deliver("pull_request.opened", {
      secret: "another-secret",
    });

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "WEBHOOK_SIGNATURE_INVALID" });
    expect(text).not.toContain("acme");
    expect(h.intake.calls).toBe(0);
    expect(await h.snapshotTables()).toEqual(tables);
    expect(h.fake.requests()).toHaveLength(requests);
    expect(h.parseEvent).not.toHaveBeenCalled();
  });

  // CR-22-T04
  it("is refused when the signature belongs to another body", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const otherBody = JSON.stringify({ action: "opened", other: true });

    const response = await h.deliver("pull_request.opened", {
      signature: signWebhookBody(otherBody, TEST_WEBHOOK_SECRET),
    });

    expect(response.status).toBe(401);
    expect(h.intake.calls).toBe(0);
    expect((await h.snapshotTables()).deliveries).toEqual([]);
  });

  // CR-22-T05
  it("is refused when the signature header is missing", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    const response = await h.deliver("pull_request.opened", {
      signature: null,
    });

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
    expect(h.intake.calls).toBe(0);
  });

  it("is refused before the headers or the JSON are looked at", async () => {
    const h = await startWebhookHarness();

    const response = await h.deliverRaw(
      "not json",
      { "x-github-event": null, "x-github-delivery": null },
      "sha256=" + "0".repeat(64),
    );

    expect(response.status).toBe(401);
  });
});

describe("a delivery that is signed but not usable", () => {
  // CR-22-T11
  it("is refused with 400 when the body is not JSON", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    const response = await h.deliverRaw("{ this is not json");

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "WEBHOOK_BODY_NOT_JSON" });
    expect(h.intake.calls).toBe(0);
    expect((await h.snapshotTables()).deliveries).toEqual([]);
  });

  // CR-22-T11
  it("is refused with 400 when the event header is missing or malformed", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const body = JSON.stringify(webhookFixture("pull_request.opened"));

    const missing = await h.deliverRaw(body, { "x-github-event": null });
    const malformed = await h.deliverRaw(body, {
      "x-github-event": "pull request!",
    });

    expect(missing.status).toBe(400);
    expect(await json(missing)).toEqual({
      error: "WEBHOOK_EVENT_HEADER_INVALID",
    });
    expect(malformed.status).toBe(400);
    expect(h.intake.calls).toBe(0);
  });

  // CR-22-T11
  it("is refused with 400 when the delivery header is missing or malformed", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const body = JSON.stringify(webhookFixture("pull_request.opened"));

    const missing = await h.deliverRaw(body, { "x-github-delivery": null });
    const malformed = await h.deliverRaw(body, {
      "x-github-delivery": "../../etc/passwd",
    });

    expect(missing.status).toBe(400);
    expect(await json(missing)).toEqual({
      error: "WEBHOOK_DELIVERY_HEADER_INVALID",
    });
    expect(malformed.status).toBe(400);
    expect(h.intake.calls).toBe(0);
    expect((await h.snapshotTables()).deliveries).toEqual([]);
  });

  // CR-22-T10
  it.each(["ping", "push"])(
    "accepts a %s event with 202 and does nothing at all",
    async (fixture) => {
      const h = await startWebhookHarness();
      await h.seedInstallation();
      const tables = await h.snapshotTables();
      const requests = h.fake.requests().length;

      const response = await h.deliver(fixture);

      expect(response.status).toBe(202);
      expect(await json(response)).toEqual({
        status: "accepted",
        outcome: "event_not_used",
      });
      expect(h.intake.calls).toBe(0);
      expect(await h.snapshotTables()).toEqual(tables);
      expect(h.fake.requests()).toHaveLength(requests);
    },
  );
});

describe("a body that is too large", () => {
  const oversized = (bytes: number) =>
    JSON.stringify({ padding: "x".repeat(bytes) });

  // CR-22-T12
  it("is refused with 413 before the signature is checked, and nothing is processed", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const tables = await h.snapshotTables();
    const body = oversized(WEBHOOK_MAX_BODY_BYTES);

    const response = await h.deliverRaw(body);

    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({ error: "WEBHOOK_BODY_TOO_LARGE" });
    expect(h.verifyWebhook).not.toHaveBeenCalled();
    expect(h.intake.calls).toBe(0);
    expect(await h.snapshotTables()).toEqual(tables);
  });

  // CR-22-T12
  it("is refused with 413 when it grows past the limit without announcing its length", async () => {
    const h = await startWebhookHarness();
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent > 2 * WEBHOOK_MAX_BODY_BYTES) controller.close();
        else controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });

    const response = await h.handler(
      new Request("https://app.test/api/webhooks/github-app", {
        method: "POST",
        headers: { "x-github-event": "pull_request" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(2 * WEBHOOK_MAX_BODY_BYTES);
    expect(h.verifyWebhook).not.toHaveBeenCalled();
  });

  it("is still accepted when it is exactly as large as the limit", async () => {
    const h = await startWebhookHarness();
    const overhead = oversized(0).length;
    const body = oversized(WEBHOOK_MAX_BODY_BYTES - overhead);
    expect(Buffer.byteLength(body)).toBe(WEBHOOK_MAX_BODY_BYTES);

    const response = await h.deliverRaw(body, { "x-github-event": "ping" });

    expect(response.status).toBe(202);
  });
});

describe("a delivery that arrives again", () => {
  // CR-22-T07
  it("is accepted with 202 and produces no second trigger", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    const first = await h.deliver("pull_request.opened", {
      deliveryId: "delivery-1",
    });
    const second = await h.deliver("pull_request.opened", {
      deliveryId: "delivery-1",
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await json(second)).toMatchObject({ outcome: "duplicate" });
    expect(h.intake.triggers).toHaveLength(1);
    expect((await h.snapshotTables()).deliveries).toHaveLength(1);
  });

  it("does not ask GitHub again", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
    await h.deliver("issue_comment.created.review", { deliveryId: "d-1" });
    const requests = h.fake.requests().length;

    await h.deliver("issue_comment.created.review", { deliveryId: "d-1" });

    expect(h.fake.requests()).toHaveLength(requests);
  });

  it("is handled as new when another delivery id carries the same event", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();

    await h.deliver("pull_request.opened", { deliveryId: "delivery-1" });
    await h.deliver("pull_request.opened", { deliveryId: "delivery-2" });

    expect(h.intake.triggers).toHaveLength(2);
  });

  // CR-22-T08
  it("produces exactly one trigger when two requests with the same id are in flight at once", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    h.intake.delay(50);

    const responses = await Promise.all([
      h.deliver("pull_request.opened", { deliveryId: "delivery-1" }),
      h.deliver("pull_request.opened", { deliveryId: "delivery-1" }),
      h.deliver("pull_request.opened", { deliveryId: "delivery-1" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      202, 202, 202,
    ]);
    expect(h.intake.triggers).toHaveLength(1);
    expect(h.intake.calls).toBe(1);
  });
});

describe("a delivery whose handling fails", () => {
  const databaseError = () =>
    Object.assign(new Error("SQLITE_ERROR: no such table: jobs"), {
      code: "SQLITE_ERROR",
    });

  // CR-22-T13
  it("is answered with 500, is not remembered, and creates the trigger when it is delivered again", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    h.intake.failWith(databaseError());

    const failed = await h.deliver("pull_request.opened", {
      deliveryId: "delivery-1",
    });

    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ error: "WEBHOOK_PROCESSING_FAILED" });
    expect(text).not.toContain("jobs");
    expect((await h.snapshotTables()).deliveries).toEqual([]);

    h.intake.recover();
    const retried = await h.deliver("pull_request.opened", {
      deliveryId: "delivery-1",
    });

    expect(retried.status).toBe(202);
    expect(h.intake.triggers).toHaveLength(1);
    expect(
      (await h.snapshotTables()).deliveries.map((row) => row.outcome),
    ).toEqual(["trigger_enqueued"]);
  });

  it("is answered with 500 and not remembered when GitHub fails while the delivery is translated", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
    h.fake.fail({ pathIncludes: "/collaborators/", status: 500, times: 1 });

    const failed = await h.deliver("issue_comment.created.review", {
      deliveryId: "delivery-1",
    });

    expect(failed.status).toBe(500);
    expect((await h.snapshotTables()).deliveries).toEqual([]);

    const retried = await h.deliver("issue_comment.created.review", {
      deliveryId: "delivery-1",
    });

    expect(retried.status).toBe(202);
    expect(h.intake.triggers).toHaveLength(1);
  });

  it("answers 503 and handles nothing when the webhook secret is not configured", async () => {
    const h = await startWebhookHarness({
      env: { GITHUB_APP_WEBHOOK_SECRET: undefined },
    });

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ error: "WEBHOOK_NOT_CONFIGURED" });
    expect(h.intake.calls).toBe(0);
    expect(h.errorLines.join("\n")).toContain("GITHUB_APP_WEBHOOK_SECRET");
  });
});

describe("what the route lets out", () => {
  // CR-22-T14
  it("never puts the webhook secret or a signature in an answer or a log line", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      });
    const body = JSON.stringify(webhookFixture("pull_request.opened"));
    const goodSignature = signWebhookBody(body, TEST_WEBHOOK_SECRET);
    const wrongSecret = "another-secret";
    const wrongSignature = signWebhookBody(body, wrongSecret);
    h.intake.failWith(new Error("storage failed"));

    const responses = [
      await h.deliverRaw(body), // valid, but the intake fails
      await h.deliverRaw(body, {}, wrongSignature), // refused
      await h.deliverRaw(body, {}, "sha256=" + "f".repeat(64)), // refused
      await h.deliverRaw(body, {}, null), // refused
      await h.deliver("issue_comment.created.review"),
    ];
    const texts = await Promise.all(responses.map((r) => r.text()));

    const everything = [
      ...texts,
      ...h.logLines(),
      ...consoleLines,
      ...responses.flatMap((r) => [...r.headers.values()]),
    ].join("\n");
    for (const secret of [
      TEST_WEBHOOK_SECRET,
      wrongSecret,
      goodSignature,
      goodSignature.slice("sha256=".length),
      wrongSignature,
      createHmac("sha256", TEST_WEBHOOK_SECRET).update(body).digest("base64"),
    ])
      expect(everything).not.toContain(secret);
    expect(responses.map((r) => r.status)).toEqual([500, 401, 401, 401, 500]);
    expect(h.logLines().length).toBeGreaterThan(0);
  });
});
