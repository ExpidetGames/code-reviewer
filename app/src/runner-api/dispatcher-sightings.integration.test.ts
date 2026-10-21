// SPDX-License-Identifier: Apache-2.0

// #498 (the gate of the review of #524): the claim route notes which Dispatchers it serves, by the features a claim names.
// A claim that names `worker_credential` is a Dispatcher's, and `vm_lifecycle` next to it says it reports its VMs.
import { describe, expect, it } from "vitest";
import { readStoredDispatcherSightings } from "../billing/dispatcher-features.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";

describe("the Dispatchers the claim route has seen", () => {
  // #498-B1
  it("notes a Dispatcher that names `vm_lifecycle` and one that does not, and no runner", async () => {
    const h = await startRunnerApiHarness();

    await h.claim({ engines: ["pr-agent"], features: ["supersede"] });
    expect(await readStoredDispatcherSightings(h.db)).toStrictEqual({});

    await h.claim({
      engines: ["pr-agent"],
      features: ["worker_credential", "vm_lifecycle"],
    });
    expect(await readStoredDispatcherSightings(h.db)).toStrictEqual({
      withVmLifecycleAt: h.clock.now().toISOString(),
    });

    await h.claim({ engines: ["pr-agent"], features: ["worker_credential"] });
    expect(await readStoredDispatcherSightings(h.db)).toStrictEqual({
      withVmLifecycleAt: h.clock.now().toISOString(),
      withoutVmLifecycleAt: h.clock.now().toISOString(),
    });
  });

  // #498-B1
  it("answers the claim as before, whether or not the note could be made", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const answer = await h.claim({
      engines: ["pr-agent"],
      features: ["worker_credential", "vm_lifecycle"],
    });

    expect(answer.status).toBe(200);
    expect((await h.queue.get(job.id))?.status).toBe("running");
  });
});
