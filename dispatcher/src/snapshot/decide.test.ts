// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { decide, type DecideDeps } from "./decide.ts";
import { IMAGE_INPUT_PATHS, type SnapshotPair } from "./pair.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const PAIR: SnapshotPair = {
  snapshotId: "snap_example01",
  imageDigest: `sha256:${"a".repeat(64)}`,
  commit: OLD,
};

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps & {
  asked: Array<{ from: string; to: string; paths: readonly string[] }>;
} {
  const asked: Array<{ from: string; to: string; paths: readonly string[] }> =
    [];
  return {
    asked,
    live: () => Promise.resolve(undefined),
    projectPair: () => PAIR,
    commitKnown: () => Promise.resolve(true),
    changed: (from, to, paths) => {
      asked.push({ from, to, paths });
      return Promise.resolve(false);
    },
    ...overrides,
  };
}

describe("whether the snapshot has to be rebuilt", () => {
  // #403-T13
  it("reuses the pair when no input of the Worker image changed since its commit", async () => {
    const d = deps();

    const decision = await decide({ sha: NEW, force: false, deps: d });

    expect(decision).toEqual({
      rebuild: false,
      reason: "inputs_unchanged",
      pair: PAIR,
      repair: false,
    });
    expect(d.asked).toEqual([{ from: OLD, to: NEW, paths: IMAGE_INPUT_PATHS }]);
  });

  // #403-T13
  it("rebuilds when an input of the Worker image changed", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ changed: () => Promise.resolve(true) }),
    });

    expect(decision).toMatchObject({ rebuild: true, reason: "inputs_changed" });
    expect(decision.pair).toBeUndefined();
  });

  // #403-T13
  it("rebuilds when the commit of the pair is not in this clone", async () => {
    const d = deps({ commitKnown: () => Promise.resolve(false) });

    const decision = await decide({ sha: NEW, force: false, deps: d });

    expect(decision).toMatchObject({ rebuild: true, reason: "commit_unknown" });
    expect(d.asked).toEqual([]);
  });

  // #403-T13
  it("rebuilds when no complete pair is configured (the first deployment, or a value that is missing)", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ projectPair: () => undefined }),
    });

    expect(decision).toMatchObject({ rebuild: true, reason: "pair_missing" });
  });

  // #403-T13
  it("rebuilds when asked to, without looking at the inputs", async () => {
    const d = deps();

    const decision = await decide({ sha: NEW, force: true, deps: d });

    expect(decision).toMatchObject({ rebuild: true, reason: "forced" });
    expect(d.asked).toEqual([]);
  });

  // #403-T13
  it("stops the run, and does not guess, when the inputs cannot be compared", async () => {
    await expect(
      decide({
        sha: NEW,
        force: false,
        deps: deps({ changed: () => Promise.reject(new Error("git failed")) }),
      }),
    ).rejects.toThrow();
  });

  // #403-T13
  it("trusts the live deployment over the variables when they differ, and asks for the variables to be repaired", async () => {
    const livePair: SnapshotPair = {
      snapshotId: "snap_example02",
      imageDigest: `sha256:${"b".repeat(64)}`,
      commit: NEW,
    };
    const d = deps({ live: () => Promise.resolve(livePair) });

    const decision = await decide({ sha: NEW, force: false, deps: d });

    // A run that promoted and then could not write the variables left them behind: the live pair is the truth.
    expect(decision).toEqual({
      rebuild: false,
      reason: "inputs_unchanged",
      pair: livePair,
      repair: true,
    });
    expect(d.asked[0]).toMatchObject({ from: NEW, to: NEW });
  });

  // #403-T13
  it("does not ask for a repair when the live deployment and the variables agree", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ live: () => Promise.resolve(PAIR) }),
    });

    expect(decision.repair).toBe(false);
  });

  // #403-T13
  it("falls back to the variables when the live deployment carries no pair (a deployment made by hand)", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ live: () => Promise.resolve(undefined) }),
    });

    expect(decision).toMatchObject({
      rebuild: false,
      pair: PAIR,
      repair: false,
    });
  });
});
