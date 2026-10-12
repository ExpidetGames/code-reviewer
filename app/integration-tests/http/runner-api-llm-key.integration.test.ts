// SPDX-License-Identifier: Apache-2.0

// The LLM key of a claim comes from the workspace of the job and from nowhere else (docs/decisions/0001-
// editions-setup-and-accounts.md, sections 2.8 and 2.10): each workspace's job carries that workspace's key, a
// workspace without a key fails with `llm_not_configured` instead of borrowing another one, the legacy
// variables only serve a single-tenant instance, and a key that was handed out can be masked in the result
// whichever app instance completes the job.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createJobQueue } from "../../src/jobs/job-queue.ts";
import { sha } from "../../src/test-support/jobs.ts";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_LLM_MODEL,
  TEST_RUNNER_TOKEN,
} from "../../src/test-support/runner-api-harness.ts";
import { addWorkspace } from "../../src/test-support/workspaces.ts";

type Harness = Awaited<ReturnType<typeof startRunnerApiHarness>>;

const KEY_A = "sk-or-v1-sentinel-key-of-workspace-alpha-0001";
const KEY_B = "sk-or-v1-sentinel-key-of-workspace-bravo-0002";
const KEY_ROTATED = "sk-or-v1-rotated-key-of-workspace-alpha-0003";
const NO_LEGACY_KEY = { LLM_PROVIDER: undefined, LLM_API_KEY: undefined };

/** A harness whose environment has no legacy key, so a key can only come from a workspace. */
function startWithoutLegacyKey() {
  return startRunnerApiHarness({ env: NO_LEGACY_KEY });
}

async function saveKey(h: Harness, workspaceId: string, apiKey: string) {
  const result = await h.llm
    .keyServiceFor(workspaceId)
    .save({ provider: "openrouter", apiKey }, null);
  expect(result.ok).toBe(true);
}

/** Another workspace with its own connection, repository and one waiting job. */
async function addWorkspaceWithJob(
  h: Harness,
  slug: string,
  installationId: number,
) {
  const workspaceId = await addWorkspace(h.db, slug);
  const integration = await createIntegrationsRepository(
    h.db,
    workspaceId,
    h.clock.now,
  ).create({
    type: "github_app",
    displayName: slug,
    externalId: String(installationId),
    config: {},
  });
  const repositories = createRepositoriesRepository(
    h.db,
    workspaceId,
    h.clock.now,
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: String(installationId + 1000),
      fullName: `${slug}/tools`,
      url: `https://github.test/${slug}/tools`,
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  h.fake.addInstallation({
    id: installationId,
    account: { login: slug, id: installationId + 2000, type: "Organization" },
  });
  h.fake.setRepositories(installationId, [
    { id: installationId + 1000, fullName: `${slug}/tools` },
  ]);
  h.fake.addPullRequest(`${slug}/tools`, {
    number: 7,
    title: "Change 7",
    state: "open",
    headSha: sha("a"),
    headRef: "feature/change-7",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  const enqueued = await createJobQueue(h.db, workspaceId, {
    now: h.clock.now,
  }).enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: `https://github.test/${slug}/tools/pull/7`,
    headSha: sha("a"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
  });
  if (enqueued.status !== "created") throw new Error("seeding failed");
  return { workspaceId, job: enqueued.job };
}

describe("the key a claim hands out", () => {
  // #104-LK-05
  it("is the key of the workspace of each job, and a workspace without a key fails with llm_not_configured", async () => {
    const h = await startWithoutLegacyKey();
    const first = await h.enqueueNew();
    h.clock.advance(1000);
    const bravo = await addWorkspaceWithJob(h, "bravo", 4343);
    h.clock.advance(1000);
    const charlie = await addWorkspaceWithJob(h, "charlie", 4444);
    await saveKey(h, first.workspaceId, KEY_A);
    await saveKey(h, bravo.workspaceId, KEY_B);

    const one = await h.claim();
    const two = await h.claim();
    const three = await h.claim();

    const oneText = await one.text();
    const twoText = await two.text();
    expect(one.status).toBe(200);
    expect(JSON.parse(oneText).job.input.llm.apiKey).toBe(KEY_A);
    expect(oneText).not.toContain(KEY_B);
    expect(two.status).toBe(200);
    expect(JSON.parse(twoText).job.input.llm.apiKey).toBe(KEY_B);
    expect(twoText).not.toContain(KEY_A);
    // The third workspace has no key and does not get one of the others: its job fails, the runner hears nothing.
    expect(three.status).toBe(204);
    expect(await h.queue.get(charlie.job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(await three.text()).not.toMatch(/sentinel/);
    const everything = [
      ...h.logLines(),
      JSON.stringify(await h.snapshotJobs()),
    ].join("\n");
    expect(everything).not.toContain(KEY_A);
    expect(everything).not.toContain(KEY_B);
  });

  // #104-LK-05
  it("never gives the job of a workspace without a key the key of another workspace", async () => {
    const h = await startWithoutLegacyKey();
    const bravo = await addWorkspaceWithJob(h, "bravo", 4343);
    await saveKey(h, bravo.workspaceId, KEY_B);
    const first = await h.enqueueNew();

    const response = await h.claim();

    // The job of the default workspace is the newer one here; the oldest due job is bravo's.
    expect(response.status).toBe(200);
    expect((await response.json()).job.id).toBe(bravo.job.id);
    expect(await h.claim()).toMatchObject({ status: 204 });
    expect(await h.queue.get(first.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
  });

  // #104-LK-05
  it("uses the model and the context window the instance suggests for a workspace key", async () => {
    const h = await startRunnerApiHarness({
      env: {
        ...NO_LEGACY_KEY,
        LLM_MODEL: "vendor/instance-model",
        LLM_MAX_TOKENS: "64000",
      },
    });
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);

    const claimed = await h.claimed();

    expect(claimed.job.input.llm).toEqual({
      provider: "openrouter",
      model: "vendor/instance-model",
      apiKey: KEY_A,
      maxTokens: 64000,
    });
  });

  // #104-LK-10
  it("uses the built-in default model for a workspace key when the instance's model name is invalid", async () => {
    const h = await startRunnerApiHarness({
      env: { ...NO_LEGACY_KEY, LLM_MODEL: "not a model name" },
    });
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);

    const claimed = await h.claimed();

    expect(claimed.job.input.llm.model).toBe("anthropic/claude-haiku-5.5");
    expect(claimed.job.input.llm.apiKey).toBe(KEY_A);
  });

  // #104-LK-12
  it("still works with only the legacy variables, and a workspace key overrides them", async () => {
    const h = await startRunnerApiHarness();
    const first = await h.enqueueNew();
    const legacy = await h.claimed();
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8 });
    await saveKey(h, first.workspaceId, KEY_A);

    const own = await h.claimed();

    expect(legacy.job.input.llm.apiKey).toBe(TEST_LLM_API_KEY);
    expect(own.job.input.llm.apiKey).toBe(KEY_A);
    expect(own.job.input.llm.model).toBe(TEST_LLM_MODEL);
  });

  // #104-LK-12
  it("does not hand the legacy variables to a workspace of a multi-tenant instance", async () => {
    const h = await startRunnerApiHarness();
    await createInstanceSettingsRepository(h.db).set("tenancy", "multi", null);
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).not.toContain(TEST_LLM_API_KEY);
  });

  it("fails closed for a key that cannot be read, even where the legacy variables would work", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);
    await h.db
      .updateTable("workspace_secrets")
      .set({ nonce: "AAAA" })
      .execute();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).toContain("key_unreadable");
  });

  it("fails closed for a key that was entered for another provider, and does not send it", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);
    await h.db
      .updateTable("workspace_secrets")
      .set({ binding: "another-provider" })
      .execute();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).not.toContain(KEY_A);
  });
});

describe("removing or replacing the key of a workspace", () => {
  // #104-LK-08
  it("fails new claims with llm_not_configured and leaves a running job alone", async () => {
    const h = await startWithoutLegacyKey();
    const first = await h.enqueueNew();
    h.clock.advance(1000);
    const second = await h.enqueueNew({ prNumber: 8 });
    await saveKey(h, first.workspaceId, KEY_A);
    const running = await h.claimed();

    expect(await h.llm.keyServiceFor(first.workspaceId).remove()).toBe(true);
    const next = await h.claim();
    const heartbeat = await h.heartbeat(running.job.id, running.job.leaseToken);
    const complete = await h.complete(running.job.id, running.job.leaseToken);

    expect(next.status).toBe(204);
    expect(await h.queue.get(second.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(heartbeat.status).toBe(200);
    expect(complete.status).toBe(200);
    expect(await h.queue.get(running.job.id)).toMatchObject({
      status: "succeeded",
    });
  });

  // #104-LK-07
  it("masks the key of the claim in the result when another app instance completes the job after the key was rotated", async () => {
    const h = await startWithoutLegacyKey();
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);
    const claimed = await h.claimed();
    expect(claimed.job.input.llm.apiKey).toBe(KEY_A);
    await saveKey(h, job.workspaceId, KEY_ROTATED);
    const secondInstance = h.anotherInstance();

    const completed = await secondInstance.complete(
      job.id,
      claimed.job.leaseToken,
      {
        logTail: `calling the provider with ${KEY_A} (old) and ${KEY_ROTATED} (new)`,
        errorMessage: `Incorrect API key provided: ${encodeURIComponent(KEY_A)}`,
      },
    );

    expect(completed.status).toBe(200);
    const stored = JSON.stringify((await h.queue.get(job.id))?.result ?? null);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain(KEY_A);
    expect(stored).not.toContain(KEY_ROTATED);
    expect(stored).not.toContain(encodeURIComponent(KEY_A));
  });

  // #104-LK-07
  it("keeps the key of the claim in the database, encrypted, and not in the memory of an instance", async () => {
    const h = await startWithoutLegacyKey();
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);
    await h.claimed();

    const rows = await h.db
      .selectFrom("job_claimed_keys")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe(job.id);
    expect(JSON.stringify(rows)).not.toContain(KEY_A);
    // A fresh instance finds it; nothing was kept in the first one's memory for it.
    expect(await h.anotherInstance().claimedKeys.keysOf(job.id)).toEqual([
      KEY_A,
    ]);
  });

  it("does not hand the job out when its key cannot be remembered", async () => {
    const h = await startWithoutLegacyKey();
    const job = await h.enqueueNew();
    await saveKey(h, job.workspaceId, KEY_A);
    await h.db.schema.dropTable("job_claimed_keys").execute();

    const response = await h.claim();

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(KEY_A);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "queued" });
    expect(h.logLines().join("\n")).not.toContain(KEY_A);
    expect(h.logLines().join("\n")).not.toContain(TEST_RUNNER_TOKEN);
  });
});
