// Pins down that the webhook route only starts work for a repository with an active project: a
// signed pull request delivery for a repository without a project, with a deactivated one, or with
// one whose repository disappeared is answered 202 and hands nothing to the intake. Such a delivery is
// recorded but not kept as a duplicate, so redelivering it after the project was activated works.
import { describe, expect, it } from "vitest";
import { startWebhookHarness } from "../../src/test-support/webhook-harness.ts";

async function repositoryIdOf(
  h: Awaited<ReturnType<typeof startWebhookHarness>>,
) {
  const [repository] = await h.repositories.list();
  if (repository === undefined) throw new Error("no repository");
  return repository.id;
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe("a pull request delivery for a repository that is not a project", () => {
  // CR-24-T03
  it("is answered 202 without a trigger when the repository has no project", async () => {
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
  it("is answered 202 without a trigger when the project was deactivated", async () => {
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

  // CR-24-T04
  it("is answered 202 without a trigger for a comment command too", async () => {
    const h = await startWebhookHarness();
    await h.seedInstallation({ activateProject: false });

    const response = await h.deliver("issue_comment.created.review");

    expect(response.status).toBe(202);
    expect(h.intake.calls).toBe(0);
  });

  it("is answered 202 without a trigger when the repository left the installation", async () => {
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

    await h.projects.activateProject(await repositoryIdOf(h));
    const second = await h.deliver("pull_request.opened", { deliveryId });

    expect(await json(second)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(h.intake.triggers).toHaveLength(1);
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
