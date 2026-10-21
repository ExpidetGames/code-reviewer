// SPDX-License-Identifier: Apache-2.0

// The key mode of the workspace at the claim of the runner API (#496): while billing is on the key a job is given is the one the
// workspace chose (our models by default), never the entitlement's key mode; with billing off nothing changes. A choice of the
// workspace's own key without a stored key ends the job `llm_not_configured` (`no_key`) and never falls back to our key. A choice
// made after the claim does not touch the job that runs.
import { describe, expect, it } from "vitest";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createLlmKeyModeStore } from "../../src/llm/key-mode-store.ts";
import { DEFAULT_LLM_PROVIDER } from "../../src/llm/providers/index.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../../src/test-support/billing-switch.ts";
import type {
  EntitlementsData,
  KeyMode,
} from "../../src/workspaces/entitlements.ts";

// Keys that no shape of src/runner-api/redact.ts matches, so only what the app remembers can mask them.
const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";

function entitlements(keyMode: KeyMode): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

async function start(
  options: {
    billing: "on" | "off";
    choice?: KeyMode;
    entitlement?: KeyMode;
    ownKey?: boolean;
  } = { billing: "on" },
): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    llmKey: options.ownKey === false ? null : WORKSPACE_KEY,
  });
  const saved = await h.llm
    .operatorKey()
    .save({ provider: DEFAULT_LLM_PROVIDER, apiKey: OPERATOR_KEY }, null);
  expect(saved.ok).toBe(true);
  if (options.entitlement !== undefined)
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements(options.entitlement), null);
  if (options.choice !== undefined) await choose(h, options.choice);
  await setBillingSwitch(h.db, options.billing === "on");
  if (options.billing === "on")
    await fundWorkspace(h.db, h.workspaceId, 5_000_000, h.clock.now);
  return h;
}

const choose = (h: RunnerApiHarness, mode: KeyMode) =>
  createLlmKeyModeStore(h.db, h.workspaceId, h.clock.now).set(mode, null);

const recordOf = (h: RunnerApiHarness, jobId: string) =>
  createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(jobId);

describe("the claim with billing off", () => {
  // #496-T03
  it("hands a workspace without entitlements its own key and an own entitlement its own key, whatever the workspace chose", async () => {
    for (const entitlement of [undefined, "own"] as const) {
      const h = await start({
        billing: "off",
        choice: "managed",
        ...(entitlement === undefined ? {} : { entitlement }),
      });
      const job = await h.enqueueNew();

      const claimed = await h.claimed();

      expect(claimed.job.input.llm.apiKey).toBe(WORKSPACE_KEY);
      expect((await recordOf(h, job.id))?.keyMode).toBe("own");
    }
  });

  // #496-T03
  it("hands a managed entitlement the operator's key, whatever the workspace chose", async () => {
    const h = await start({
      billing: "off",
      choice: "own",
      entitlement: "managed",
    });
    const job = await h.enqueueNew();

    const claimed = await h.claimed();

    expect(claimed.job.input.llm.apiKey).toBe(OPERATOR_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
  });
});

describe("the claim with billing on", () => {
  // #496-T04
  it("runs the job on the workspace's own key when it chose its own key, and records the key mode own", async () => {
    const h = await start({ billing: "on", choice: "own" });
    const job = await h.enqueueNew();

    const claimed = await h.claimed();

    expect(claimed.job.input.llm.apiKey).toBe(WORKSPACE_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("own");
  });

  // #496-T05
  it("ends the job llm_not_configured (no_key) when it chose its own key and has none, never on our key", async () => {
    const h = await start({ billing: "on", choice: "own", ownKey: false });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).toContain("no_key");
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #496-T06
  it("runs the job on the operator's key and catalog when it chose our models, though it has an own key stored", async () => {
    const h = await start({ billing: "on", choice: "managed" });
    const job = await h.enqueueNew();
    const claimed = await h.claimed();

    expect(claimed.job.input.llm.apiKey).toBe(OPERATOR_KEY);
    expect(JSON.stringify(claimed)).not.toContain(WORKSPACE_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
  });

  // #496-T02
  it("runs the job of a workspace that has not chosen, without entitlements and with an own entitlement, on our models", async () => {
    for (const entitlement of [undefined, "own"] as const) {
      const h = await start({
        billing: "on",
        ...(entitlement === undefined ? {} : { entitlement }),
      });
      const job = await h.enqueueNew();

      const claimed = await h.claimed();

      expect(claimed.job.input.llm.apiKey).toBe(OPERATOR_KEY);
      expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
    }
  });

  // #496-T06
  it("does not touch a job that runs when the workspace switches afterwards: its key is still masked in its result", async () => {
    const h = await start({ billing: "on", choice: "managed" });
    const job = await h.enqueueNew();
    const claimed = await h.claimed();
    expect(claimed.job.input.llm.apiKey).toBe(OPERATOR_KEY);

    await choose(h, "own");
    const completed = await h.complete(job.id, claimed.job.leaseToken, {
      logTail: `with ${OPERATOR_KEY} and ${WORKSPACE_KEY}`,
    });

    expect(completed.status).toBe(200);
    expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
    const stored = JSON.stringify((await h.queue.get(job.id))?.result ?? null);
    expect(stored).not.toContain(OPERATOR_KEY);
    expect(stored).not.toContain(WORKSPACE_KEY);
  });
});

describe("the key mode of a claim in the split path (Dispatcher claims, Worker fetches)", () => {
  // #496-T11
  it("serves the Worker the key of the mode at the claim and keeps the record, when the workspace switches from own to our models in between", async () => {
    const h = await start({ billing: "on", choice: "own" });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    expect((await recordOf(h, job.id))?.keyMode).toBe("own");

    await choose(h, "managed");
    const response = await h.worker.details(claim.job.id, claim.job.credential);

    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain(WORKSPACE_KEY);
    expect(body).not.toContain(OPERATOR_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("own");
  });

  // #496-T11
  it("serves the Worker the key of the mode at the claim and keeps the record, when the workspace switches from our models to its own key in between", async () => {
    const h = await start({ billing: "on", choice: "managed" });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    expect((await recordOf(h, job.id))?.keyMode).toBe("managed");

    await choose(h, "own");
    const response = await h.worker.details(claim.job.id, claim.job.credential);

    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain(OPERATOR_KEY);
    expect(body).not.toContain(WORKSPACE_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
  });

  // #496-T11
  it("serves every re-fetch of the same claim the key of the claim, whatever the workspace chose meanwhile", async () => {
    const h = await start({ billing: "on", choice: "managed" });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();

    for (const choice of ["own", "managed", "own"] as const) {
      await choose(h, choice);
      const response = await h.worker.details(
        claim.job.id,
        claim.job.credential,
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain(OPERATOR_KEY);
      expect((await recordOf(h, job.id))?.keyMode).toBe("managed");
    }
  });

  // #496-T11
  it("masks the key of the claim in the result the Worker sends after a switch", async () => {
    const h = await start({ billing: "on", choice: "managed" });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    await choose(h, "own");
    await h.worker.details(claim.job.id, claim.job.credential);

    const completed = await h.worker.result(job.id, claim.job.credential, {
      logTail: `with ${OPERATOR_KEY}`,
    });

    expect(completed.status).toBe(200);
    expect(
      JSON.stringify((await h.queue.get(job.id))?.result ?? null),
    ).not.toContain(OPERATOR_KEY);
  });

  // #496-T11
  it("keeps the record of the inline claim on the mode of the claim, and a choice after it does not reach the job", async () => {
    const h = await start({ billing: "on", choice: "own" });
    const job = await h.enqueueNew();
    const claimed = await h.claimed();
    await choose(h, "managed");

    expect(claimed.job.input.llm.apiKey).toBe(WORKSPACE_KEY);
    expect((await recordOf(h, job.id))?.keyMode).toBe("own");
  });
});
