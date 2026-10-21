// SPDX-License-Identifier: Apache-2.0

// How often the billing switch is read on the hot paths of a claim (#496): the claim reads it once, in the transaction that decides
// the key mode, and hands the answer on; the checks that follow (the runner's claim, the Worker's fetch) read the key mode the claim
// recorded and never the switch or the workspace's choice again; the masking of a result reads it once. Counted at the two
// functions that read the stored switch for the rest of the app (`isBillingOn`, `readBillingSwitch`).
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { KeyMode } from "../../src/workspaces/entitlements.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/billing/enabled.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/billing/enabled.ts")>();
  return {
    ...original,
    isBillingOn: (...args: Parameters<typeof original.isBillingOn>) => {
      reads.count += 1;
      return original.isBillingOn(...args);
    },
    readBillingSwitch: (
      ...args: Parameters<typeof original.readBillingSwitch>
    ) => {
      reads.count += 1;
      return original.readBillingSwitch(...args);
    },
  };
});

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";

async function start(
  billing: "on" | "off",
  choice: KeyMode = "managed",
): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({ llmKey: WORKSPACE_KEY });
  const saved = await h.llm
    .operatorKey()
    .save({ provider: DEFAULT_LLM_PROVIDER, apiKey: OPERATOR_KEY }, null);
  expect(saved.ok).toBe(true);
  await createLlmKeyModeStore(h.db, h.workspaceId, h.clock.now).set(
    choice,
    null,
  );
  await setBillingSwitch(h.db, billing === "on");
  if (billing === "on")
    await fundWorkspace(h.db, h.workspaceId, 5_000_000, h.clock.now);
  return h;
}

beforeEach(() => {
  reads.count = 0;
});

describe("the reads of the billing switch", () => {
  // #496-T14
  it.each(["managed", "own"] as const)(
    "reads it once for the whole claim of a runner on %s",
    async (choice) => {
      const h = await start("on", choice);
      await h.enqueueNew();
      reads.count = 0;

      await h.claimed();

      expect(reads.count).toBe(1);
    },
  );

  // #496-T14
  it("reads it once for the claim of a Dispatcher and not at all for the fetch of its Worker", async () => {
    const h = await start("on");
    await h.enqueueNew();
    reads.count = 0;
    const claim = await h.claimedSplit();
    expect(reads.count).toBe(1);

    reads.count = 0;
    const response = await h.worker.details(claim.job.id, claim.job.credential);

    expect(response.status).toBe(200);
    expect(reads.count).toBe(0);
  });

  // #496-T14
  it.each(["on", "off"] as const)(
    "reads it once for the keys a result is masked with, billing %s",
    async (billing) => {
      const h = await start(billing, "own");
      reads.count = 0;

      await h.llm.currentKeysFor(h.workspaceId);

      expect(reads.count).toBe(1);
    },
  );
});
