// SPDX-License-Identifier: Apache-2.0

// What the queues of the running server hand to the check run service (#405): the work runs after the response, and
// within the time a request has left. A webhook, a runner request and a worker request live 60 seconds, and the
// response of the first may have spent half a minute on its inline dispatch already, so the work is given 15 seconds.
import { describe, expect, it, vi } from "vitest";
import { createCheckNotifier } from "./shared.ts";

function setup() {
  const service = {
    syncJob: vi.fn(() => Promise.resolve()),
    reconcileDue: vi.fn(() => Promise.resolve({ synced: 0 })),
  };
  const later: Array<() => Promise<void>> = [];
  const notifier = createCheckNotifier(
    () => service,
    (work) => void later.push(work),
  );
  return { service, notifier, later };
}

describe("the notifier of the queues", () => {
  // #405-T32
  it("syncs one job after the response, within 15 seconds", async () => {
    const t = setup();

    t.notifier.job("job-1");
    expect(t.service.syncJob).not.toHaveBeenCalled();
    await t.later[0]?.();

    expect(t.service.syncJob).toHaveBeenCalledWith("job-1", {
      budgetMs: 15_000,
    });
  });

  // #405-T32
  it("looks for the jobs it cannot name after the response, within 15 seconds", async () => {
    const t = setup();

    t.notifier.change();
    expect(t.service.reconcileDue).not.toHaveBeenCalled();
    await t.later[0]?.();

    expect(t.service.reconcileDue).toHaveBeenCalledWith({ budgetMs: 15_000 });
  });
});
