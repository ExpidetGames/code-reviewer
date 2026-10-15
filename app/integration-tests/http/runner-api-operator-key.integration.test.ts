// SPDX-License-Identifier: Apache-2.0

// The operator's own LLM key on both ways a key reaches a runner (#276): the legacy claim, whose response carries
// it, and the Worker API, where the first fetch of the job mints it with the per-job credential (#320). On both:
// the key of a `managed` workspace is the operator's, never the workspace's; it is remembered encrypted for
// masking; it is in no log line, no stored job row and no Dispatcher answer; and the usage record says the key
// that was really used, so the cost limit of #277 counts what it should.
import { describe, expect, it } from "vitest";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

// Keys that no shape of src/runner-api/redact.ts matches, so only what the app remembers can mask them.
const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const OPERATOR_KEY_ROTATED = "plain-operator-key-0002-bbbbbbbb";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";

function entitlements(
  keyMode: "own" | "managed",
  overrides: Partial<EntitlementsData> = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

async function start(
  keyMode: "own" | "managed" | null,
  options: {
    operatorKey?: string | null;
    entitlements?: Partial<EntitlementsData>;
  } = {},
): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({ llmKey: WORKSPACE_KEY });
  if (options.operatorKey !== null) {
    const saved = await h.llm
      .operatorKey()
      .save({ apiKey: options.operatorKey ?? OPERATOR_KEY }, null);
    expect(saved.ok).toBe(true);
  }
  if (keyMode !== null)
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements(keyMode, options.entitlements), null);
  return h;
}

async function recordOf(h: RunnerApiHarness, jobId: string) {
  return createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
    jobId,
  );
}

/** Everything the app wrote down or logged: no key of the operator and none of the workspace's in it. */
async function everythingWritten(h: RunnerApiHarness): Promise<string> {
  return [
    ...h.logLines(),
    JSON.stringify(await h.snapshotJobs()),
    JSON.stringify(
      await h.db.selectFrom("usage_records").selectAll().execute(),
    ),
    JSON.stringify(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ),
  ].join("\n");
}

describe("the legacy claim of a managed workspace", () => {
  // #276-T08
  it("hands the operator's key to the runner, and not the workspace's", async () => {
    const h = await start("managed");
    await h.enqueueNew();

    const response = await h.claim();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).job.input.llm).toMatchObject({
      provider: "openrouter",
      apiKey: OPERATOR_KEY,
    });
    expect(text).not.toContain(WORKSPACE_KEY);
    expect(await everythingWritten(h)).not.toContain(OPERATOR_KEY);
    expect(await everythingWritten(h)).not.toContain(WORKSPACE_KEY);
  });

  // #276-T08
  it("remembers the key encrypted, and masks it in a stored result even after the operator rotated it, on another app instance", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    const claimed = await h.claimed();
    expect(claimed.job.input.llm.apiKey).toBe(OPERATOR_KEY);
    const remembered = await h.db
      .selectFrom("job_claimed_keys")
      .selectAll()
      .execute();
    expect(remembered).toHaveLength(1);
    expect(JSON.stringify(remembered)).not.toContain(OPERATOR_KEY);
    expect(await h.claimedKeys.keysOf(job.id)).toEqual([OPERATOR_KEY]);
    await h.llm.operatorKey().save({ apiKey: OPERATOR_KEY_ROTATED }, null);

    const completed = await h
      .anotherInstance()
      .complete(job.id, claimed.job.leaseToken, {
        logTail: `with ${OPERATOR_KEY} (old) and ${OPERATOR_KEY_ROTATED} (new)`,
        errorMessage: `Incorrect API key: ${encodeURIComponent(OPERATOR_KEY)} ${WORKSPACE_KEY}`,
      });

    expect(completed.status).toBe(200);
    const stored = JSON.stringify((await h.queue.get(job.id))?.result ?? null);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain(OPERATOR_KEY);
    expect(stored).not.toContain(OPERATOR_KEY_ROTATED);
    expect(stored).not.toContain(encodeURIComponent(OPERATOR_KEY));
    expect(stored).not.toContain(WORKSPACE_KEY);
  });

  // #276-T03
  it("fails the job with llm_not_configured when the operator has no key, and does not fall back to the workspace's", async () => {
    const h = await start("managed", { operatorKey: null });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).toContain("operator_key_missing");
    expect(await everythingWritten(h)).not.toContain(WORKSPACE_KEY);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #276-T04
  it("fails the job closed when the operator's key cannot be read", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    await h.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).toContain("operator_key_unreadable");
  });
});

describe("the claim of a workspace that is not managed", () => {
  // #276-T05
  it("hands out the workspace's key, never the operator's, with the key mode own or without entitlements", async () => {
    for (const keyMode of ["own", null] as const) {
      const h = await start(keyMode);
      await h.enqueueNew();

      const response = await h.claim();
      const text = await response.text();

      expect(JSON.parse(text).job.input.llm.apiKey).toBe(WORKSPACE_KEY);
      expect(text).not.toContain(OPERATOR_KEY);
    }
  });

  // #276-T05
  it("fails a job without a key of its own with llm_not_configured, though the operator has one", async () => {
    for (const keyMode of ["own", null] as const) {
      const h = await start(keyMode);
      await h.setLlmKey(null);
      const job = await h.enqueueNew();

      const response = await h.claim();

      expect(response.status).toBe(204);
      expect(await h.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "llm_not_configured",
      });
      expect(await everythingWritten(h)).not.toContain(OPERATOR_KEY);
    }
  });
});

describe("the key mode of the usage record", () => {
  // #276-T02
  it("is managed for a job that ran on the operator's key and own for one that ran on the workspace's, on the legacy claim", async () => {
    const managed = await start("managed");
    const managedJob = await managed.enqueueNew();
    await managed.claimed();
    expect(await recordOf(managed, managedJob.id)).toMatchObject({
      keyMode: "managed",
    });

    const own = await start("own");
    const ownJob = await own.enqueueNew();
    await own.claimed();
    expect(await recordOf(own, ownJob.id)).toMatchObject({ keyMode: "own" });
  });

  // #276-T02
  // The note of #277: the cost limit is read from the entitlements, the record from the key that was used.
  it("makes the cost limit of #277 count the cost of a run on the operator's key", async () => {
    const h = await start("managed", {
      entitlements: {
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 1000,
        },
      },
    });
    const first = await h.enqueueNew();
    h.clock.advance(1000);
    const second = await h.enqueueNew({ prNumber: 8 });
    const claimed = await h.claimed();
    expect(claimed.job.id).toBe(first.id);
    // 0.04 USD is 40,000 micro-USD, over the limit of 1,000.
    expect((await h.complete(first.id, claimed.job.leaseToken)).status).toBe(
      200,
    );

    const next = await h.claim();

    expect(next.status).toBe(204);
    expect(await h.queue.get(second.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });

  // #276-T02
  it("follows the key that was used when the key mode changed between the claim's admission and the key lookup", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    // The claim of the legacy runner reserves the record as own and corrects it once the access is resolved; a
    // claim of a job that was reserved earlier (a lost lease) is resolved again with the entitlements of now.
    await h.claimed();
    expect(await recordOf(h, job.id)).toMatchObject({ keyMode: "managed" });

    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements("own"), null);
    h.clock.advance(10 * 60 * 1000);
    const again = await h.claimed();

    expect(again.job.id).toBe(job.id);
    expect(again.job.input.llm.apiKey).toBe(WORKSPACE_KEY);
    expect(await recordOf(h, job.id)).toMatchObject({ keyMode: "own" });
  });
});

describe("the Worker API of a managed workspace", () => {
  // #276-T08
  it("keeps the key out of the claim of a Dispatcher and mints the operator's key at the first fetch", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();

    const claimResponse = await h.claimSplit();
    const claimText = await claimResponse.text();
    const claim = JSON.parse(claimText);

    expect(claimResponse.status).toBe(200);
    expect(claimText).not.toContain(OPERATOR_KEY);
    expect(claimText).not.toContain(WORKSPACE_KEY);
    expect(claimText).not.toContain("apiKey");
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    // The record names the key the job will use already: the check at claim resolves the access.
    expect(await recordOf(h, job.id)).toMatchObject({ keyMode: "managed" });

    const details = await h.worker.details(job.id, claim.job.credential);
    const detailsText = await details.text();

    expect(details.status).toBe(200);
    expect(JSON.parse(detailsText).job.input.llm.apiKey).toBe(OPERATOR_KEY);
    expect(detailsText).not.toContain(WORKSPACE_KEY);
    expect(await h.claimedKeys.keysOf(job.id)).toEqual([OPERATOR_KEY]);
    expect(await everythingWritten(h)).not.toContain(OPERATOR_KEY);
    expect(await everythingWritten(h)).not.toContain(WORKSPACE_KEY);
  });

  // #276-T08
  it("masks the operator's key in the result a Worker reports, after the key was rotated, on another app instance", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.worker.details(job.id, claimed.credential);
    await h.llm.operatorKey().save({ apiKey: OPERATOR_KEY_ROTATED }, null);

    const response = await h.worker.result(
      job.id,
      claimed.credential,
      {
        logTail: `old ${OPERATOR_KEY} new ${OPERATOR_KEY_ROTATED}`,
        errorMessage: `failed with ${OPERATOR_KEY}`,
      },
      h.anotherInstance().workerApi,
    );

    expect(response.status).toBe(200);
    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain(OPERATOR_KEY);
    expect(stored).not.toContain(OPERATOR_KEY_ROTATED);
  });

  // #276-T03
  it("ends the job at the claim of the Dispatcher when the operator has no key: no credential, no key", async () => {
    const h = await start("managed", { operatorKey: null });
    const job = await h.enqueueNew();

    const response = await h.claimSplit();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(await everythingWritten(h)).not.toContain(WORKSPACE_KEY);
  });

  // #276-T03
  it("ends the job at the fetch when the operator's key was removed after the claim, and never uses the workspace's", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.llm.operatorKey().remove();

    const response = await h.worker.details(job.id, claimed.credential);
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).not.toContain(WORKSPACE_KEY);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #276-T02
  it("records the key that is used at the fetch when the key mode changed after the claim", async () => {
    const h = await start("managed");
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    expect(await recordOf(h, job.id)).toMatchObject({ keyMode: "managed" });
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements("own"), null);

    const details = await (
      await h.worker.details(job.id, claimed.credential)
    ).json();

    expect(details.job.input.llm.apiKey).toBe(WORKSPACE_KEY);
    expect(await recordOf(h, job.id)).toMatchObject({ keyMode: "own" });
  });
});
