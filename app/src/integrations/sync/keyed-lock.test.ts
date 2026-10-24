// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the lock that orders work on the same installation: jobs with one key run one after the
// other in the order they were asked for, jobs with different keys do not wait for each other, a
// failing job does not block the next, and the shared lock is one object per process.
import { describe, expect, it } from "vitest";
import { createKeyedLock, sharedKeyedLock } from "./keyed-lock.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the keyed lock", () => {
  it("never runs two jobs of the same key at the same time and keeps their order", async () => {
    const lock = createKeyedLock();
    const events: string[] = [];
    const gate = deferred();

    const first = lock.run("a", async () => {
      events.push("first start");
      await gate.promise;
      events.push("first end");
    });
    const second = lock.run("a", async () => {
      events.push("second start");
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual(["first start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first start", "first end", "second start"]);
  });

  it("lets jobs of different keys run side by side", async () => {
    const lock = createKeyedLock();
    const gate = deferred();
    const events: string[] = [];

    const a = lock.run("a", async () => {
      events.push("a start");
      await gate.promise;
    });
    const b = lock.run("b", async () => {
      events.push("b start");
    });
    await b;

    expect(events).toEqual(["a start", "b start"]);
    gate.resolve();
    await a;
  });

  it("runs the next job after one that failed and passes the result and the failure on", async () => {
    const lock = createKeyedLock();

    const failing = lock.run("a", async () => {
      throw new Error("boom");
    });
    const next = lock.run("a", async () => "result");

    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("result");
  });

  it("hands out one shared lock per process", () => {
    expect(sharedKeyedLock()).toBe(sharedKeyedLock());
  });
});
