// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after }));
vi.mock("../db/startup.ts", () => ({ getDatabase: () => ({}) }));

import { runAfterResponse } from "./shared.ts";

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
