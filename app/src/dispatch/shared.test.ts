// SPDX-License-Identifier: LicenseRef-Proprietary

import { beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after }));
vi.mock("../db/startup.ts", () => ({ getDatabase: () => ({}) }));

import { runAfterResponse, stopEndedClaims } from "./shared.ts";

beforeEach(() => {
  after.mockReset();
});

describe("running the dispatch after the response", () => {
  // #326-T06
  it("hands the work to after() and does not start it", () => {
    const work = vi.fn(() => Promise.resolve());

    runAfterResponse(work);

    expect(after).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
  });

  // #326-T06
  it("keeps a failing job of the work from becoming the caller's failure", async () => {
    runAfterResponse(() => Promise.reject(new Error("boom")));

    const scheduled = after.mock.calls[0]?.[0] as () => Promise<unknown>;
    await expect(scheduled()).resolves.toBeUndefined();
  });

  // #326-T06
  it("starts the work itself outside a request, where after() refuses, and still never throws", async () => {
    after.mockImplementation(() => {
      throw new Error("after was called outside a request scope");
    });
    const work = vi.fn(() => Promise.reject(new Error("boom")));

    expect(() => runAfterResponse(work)).not.toThrow();

    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();
  });
});

const WEBHOOK_ENV = {
  RUNNER_DISPATCH: "webhook",
  RUNNER_WEBHOOK_URL: "https://dispatcher.example.test/dispatch",
  RUNNER_WEBHOOK_SECRET: "example-dispatch-secret-current-00000000",
};

describe("stopping the VMs of the claims that ended", () => {
  // #487-T08
  it("does nothing while the instance polls, as a self-hosted runner or a Compose stack does", () => {
    stopEndedClaims(["job-1"], {});
    stopEndedClaims(["job-1"], { RUNNER_DISPATCH: "poll" });

    expect(after).not.toHaveBeenCalled();
  });

  // #487-T06
  it("hands the stop to after() in webhook mode, and does not start it", () => {
    stopEndedClaims(["job-1", "job-2"], WEBHOOK_ENV);

    expect(after).toHaveBeenCalledOnce();
  });

  // #487-T06
  it("does nothing for an empty list", () => {
    stopEndedClaims([], WEBHOOK_ENV);

    expect(after).not.toHaveBeenCalled();
  });

  // #487-T07
  it("never throws for a bad webhook setting and sends nothing", () => {
    expect(() =>
      stopEndedClaims(["job-1"], {
        RUNNER_DISPATCH: "webhook",
        RUNNER_WEBHOOK_URL: "not a url",
      }),
    ).not.toThrow();

    expect(after).not.toHaveBeenCalled();
  });
});
