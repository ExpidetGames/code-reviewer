// Pins down that the webhook route only starts work for a repository with an active project: a
// signed pull request or comment command delivery for a repository without a project, with a
// deactivated one, or with one whose repository disappeared is answered 202 `project_not_active` and
// hands nothing to the intake. Such a delivery is recorded but not kept as a duplicate, so
// redelivering it after the project was activated works. With two repositories in one installation
// only the delivery for the activated one is handed over.
import { describe, expect, it } from "vitest";
import {
  webhookFixture,
  type WebhookDeliveryOptions,
} from "../../../fakes/github/webhooks.ts";
import {
  startWebhookHarness,
  type WebhookHarness,
} from "../../src/test-support/webhook-harness.ts";

const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

async function repositoryIdOf(h: WebhookHarness, fullName = "acme/widgets") {
  const repository = (await h.repositories.list()).find(
    (candidate) => candidate.fullName === fullName,
  );
  if (repository === undefined) throw new Error(`no repository ${fullName}`);
  return repository.id;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** An open pull request and a commenter with write access, as the positive comment test has them. */
function prepareCommentCommand(h: WebhookHarness) {
  h.fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
}

/** A recorded pull request payload, rewritten to be about another repository. */
function pullRequestFor(
  id: number,
  fullName: string,
): Partial<WebhookDeliveryOptions> {
  const payload = webhookFixture("pull_request.opened") as unknown as {
    repository: { id: number; full_name: string; html_url: string };
  };
  payload.repository = {
    ...payload.repository,
    id,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
  };
  return { payload: payload as unknown as WebhookDeliveryOptions["payload"] };
}

async function deliveryRows(h: WebhookHarness) {
  return (await h.snapshotTables()).deliveries.map((row) => row.outcome);
}

describe("a pull request delivery for a repository that is not a project", () => {
  // CR-24-T03
  it("is answered 202 project_not_active without a trigger when the repository has no project", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      status: "accepted",
      outcome: "project_not_active",
    });
    expect(h.intake.calls).toBe(0);
    expect((await h.snapshotTables()).projects).toEqual([]);
  });

  // CR-24-T04
  it("is answered 202 project_not_active without a trigger when the project was deactivated", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    await h.projects.deactivateProject(await repositoryIdOf(h));

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      status: "accepted",
      outcome: "project_not_active",
    });
    expect(h.intake.calls).toBe(0);
  });

  it("is answered 202 project_not_active when the repository left the installation", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    const rowsBefore = (await h.snapshotTables()).projects;
    h.fake.setRepositories(4242, []);
    await h.sync.syncAll();

    const response = await h.deliver("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      outcome: "project_not_active",
    });
    expect(h.intake.calls).toBe(0);
    expect((await h.snapshotTables()).projects).toEqual(rowsBefore);
  });

  it("can be redelivered with the same id once the project is active", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    const deliveryId = "00000000-0000-4000-8000-000000000001";
    const first = await h.deliver("pull_request.opened", { deliveryId });
    expect(await json(first)).toMatchObject({ outcome: "project_not_active" });
    expect(await deliveryRows(h)).toEqual(["project_not_active"]);

    await h.projects.activateProject(await repositoryIdOf(h));
    const second = await h.deliver("pull_request.opened", { deliveryId });

    expect(await json(second)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers).toHaveLength(1);
    expect(await deliveryRows(h)).toEqual(["trigger_enqueued"]);
  });

  it("is handled as before once the project is active", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    await h.projects.activateProject(await repositoryIdOf(h));

    const response = await h.deliver("pull_request.opened");

    expect(await json(response)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers).toHaveLength(1);
  });
});

describe("a comment command for a repository that is not a project", () => {
  // CR-24-T04
  it("is handed over when the repository is a project (the setup of the tests below works)", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    prepareCommentCommand(h);

    const response = await h.deliver("issue_comment.created.review");

    expect(await json(response)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers).toHaveLength(1);
  });

  // CR-24-T03
  it("is answered 202 project_not_active without a trigger when the repository has no project", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    prepareCommentCommand(h);

    const response = await h.deliver("issue_comment.created.review", {
      deliveryId: "d-comment-1",
    });

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      status: "accepted",
      outcome: "project_not_active",
    });
    expect(h.intake.calls).toBe(0);
    expect(await deliveryRows(h)).toEqual(["project_not_active"]);
  });

  // CR-24-T04
  it("is answered 202 project_not_active without a trigger when the project was deactivated", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation();
    await h.projects.deactivateProject(await repositoryIdOf(h));
    prepareCommentCommand(h);

    const response = await h.deliver("issue_comment.created.review");

    expect(await json(response)).toMatchObject({
      outcome: "project_not_active",
    });
    expect(h.intake.calls).toBe(0);
  });

  it("can be redelivered with the same id once the project is active", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    prepareCommentCommand(h);
    await h.deliver("issue_comment.created.review", { deliveryId: "d-2" });
    await h.projects.activateProject(await repositoryIdOf(h));

    const again = await h.deliver("issue_comment.created.review", {
      deliveryId: "d-2",
    });

    expect(await json(again)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers).toHaveLength(1);
  });

  // The gate comes after `parseEvent`, because only the payload says which repository a delivery is
  // about and the provider reads it there. For a command, parsing asks GitHub twice (does the
  // commenter have write access, what is the head commit of the pull request). This test pins that
  // cost; the follow-up is to gate before parsing (see src/projects/README.md).
  it("still costs two GitHub calls for a commenter with write access", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    prepareCommentCommand(h);
    const before = h.fake.requests().length;

    await h.deliver("issue_comment.created.review");

    const calls = h.fake
      .requests()
      .slice(before)
      .map((request) => `${request.method} ${request.path}`);
    expect(calls).toHaveLength(2);
  });
});

describe("two repositories in one installation", () => {
  async function startWithTwoRepositories() {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });
    h.fake.setRepositories(4242, [
      { id: 7001, fullName: "acme/widgets" },
      { id: 7002, fullName: "acme/gadgets" },
    ]);
    await h.sync.syncAll();
    return h;
  }

  it("hands over the delivery of the activated repository and not the other one's", async () => {
    const h = await startWithTwoRepositories();
    await h.projects.activateProject(await repositoryIdOf(h, "acme/gadgets"));

    const widgets = await h.deliver(
      "pull_request.opened",
      pullRequestFor(7001, "acme/widgets"),
    );
    const gadgets = await h.deliver(
      "pull_request.opened",
      pullRequestFor(7002, "acme/gadgets"),
    );

    expect(await json(widgets)).toMatchObject({
      outcome: "project_not_active",
    });
    expect(await json(gadgets)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers.map((trigger) => trigger.repo.fullName)).toEqual([
      "acme/gadgets",
    ]);
  });

  it("decides the other way round when the other repository is the one activated", async () => {
    const h = await startWithTwoRepositories();
    await h.projects.activateProject(await repositoryIdOf(h, "acme/widgets"));

    const widgets = await h.deliver(
      "pull_request.opened",
      pullRequestFor(7001, "acme/widgets"),
    );
    const gadgets = await h.deliver(
      "pull_request.opened",
      pullRequestFor(7002, "acme/gadgets"),
    );

    expect(await json(widgets)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(await json(gadgets)).toMatchObject({
      outcome: "project_not_active",
    });
  });

  it("does not take a project of the same repository id in another installation for this one", async () => {
    const h = await startWithTwoRepositories();
    h.fake.addInstallation({
      id: 4343,
      account: { login: "octo", id: 5002, type: "Organization" },
    });
    h.fake.setRepositories(4343, [{ id: 7001, fullName: "octo/widgets" }]);
    await h.sync.syncAll();
    const other = (await h.repositories.list()).find(
      (repository) => repository.fullName === "octo/widgets",
    );
    if (other === undefined) throw new Error("no second installation repo");
    await h.projects.activateProject(other.id);

    const response = await h.deliver(
      "pull_request.opened",
      pullRequestFor(7001, "acme/widgets"),
    );

    expect(await json(response)).toMatchObject({
      outcome: "project_not_active",
    });
  });
});
