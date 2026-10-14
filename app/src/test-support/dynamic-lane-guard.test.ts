// SPDX-License-Identifier: Apache-2.0

// Pins down the network guard of the privileged Dynamic e2e lane (#253): the nft rules that count and reject
// every connection that leaves the machine, and the reading of their counters that fails a test. The rules
// sit in the kernel of the lane's network namespace, so they see OpenCode, Git, `rg`, Node and any helper
// process alike, whatever language or runtime they are written in. Here the decision is proven on the
// counters nft prints; that the counters really move for each kind of process is proven by the lane itself
// (e2e/dynamic/network-guard.e2e.ts) and cannot be proven without root.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PREFIX,
  GUARD_CHAIN,
  GUARD_TABLE,
  assertNoExternalAttempts,
  describeAttempts,
  parseGuard,
  type GuardReading,
} from "../../e2e/helpers/dynamic-lane-guard.ts";

const RULES = readFileSync(
  fileURLToPath(new URL("../../e2e/dynamic/guard.nft", import.meta.url)),
  "utf8",
);

/** What `nft -j list chain` prints for a rule: the expressions, with the counter, and the comment. */
function rule(comment: string, packets: number) {
  return {
    rule: {
      family: "inet",
      table: GUARD_TABLE,
      chain: GUARD_CHAIN,
      handle: 5,
      comment,
      expr: [
        { match: { op: "==", left: { meta: { key: "skuid" } }, right: 1 } },
        { counter: { packets, bytes: packets * 60 } },
        { reject: null },
      ],
    },
  };
}

function listing(counts: Record<string, number>) {
  return {
    nftables: [
      { metainfo: { version: "1.0.9", json_schema_version: 1 } },
      {
        chain: {
          family: "inet",
          table: GUARD_TABLE,
          name: GUARD_CHAIN,
          handle: 1,
        },
      },
      // The loopback rule has no counter and no comment: it is not one of the guard's counters.
      {
        rule: {
          family: "inet",
          table: GUARD_TABLE,
          chain: GUARD_CHAIN,
          handle: 4,
          expr: [{ accept: null }],
        },
      },
      ...Object.entries(counts).map(([comment, packets]) =>
        rule(comment, packets),
      ),
    ],
  };
}

const QUIET = {
  "control-engine": 0,
  "control-job": 0,
  "control-root": 0,
  "violation-engine": 0,
  "violation-job": 0,
  "violation-root": 0,
  "violation-other": 0,
};

describe("the network guard of the privileged Dynamic e2e lane", () => {
  // #253-G01
  it("reads the counters of the violations and of the controls apart", () => {
    const reading = parseGuard(
      listing({
        ...QUIET,
        "control-engine": 2,
        "violation-root": 3,
      }),
    );

    expect(reading).toEqual({
      violations: { engine: 0, job: 0, root: 3, other: 0 },
      controls: { engine: 2, job: 0, root: 0 },
    });
  });

  // #253-G02
  it.each([
    ["engine", "violation-engine", /OpenCode|engine/],
    ["job", "violation-job", /job/],
    ["root", "violation-root", /root/],
    ["other", "violation-other", /another user/],
  ] as const)(
    "fails when a process of the %s user reached anything but loopback, and says who",
    (_who, comment, description) => {
      const reading = parseGuard(listing({ ...QUIET, [comment]: 1 }));

      expect(() => {
        assertNoExternalAttempts(reading);
      }).toThrow(description);
      expect(describeAttempts(reading)).toHaveLength(1);
    },
  );

  // #253-G02
  it("passes when no process reached anything but loopback, controls or not", () => {
    const reading = parseGuard(
      listing({ ...QUIET, "control-engine": 4, "control-root": 1 }),
    );

    expect(() => {
      assertNoExternalAttempts(reading);
    }).not.toThrow();
  });

  // #253-G03
  it("refuses to read a ruleset that lacks a counter, because a guard that cannot see is not a guard", () => {
    const { "violation-engine": _removed, ...incomplete } = QUIET;

    expect(() => parseGuard(listing(incomplete))).toThrow(/violation-engine/);
    expect(() => parseGuard({ nftables: [] })).toThrow(/violation-engine/);
    expect(() => parseGuard("not nft output")).toThrow();
  });

  // #253-G04
  it("has a rule file that counts and rejects every destination of every kind of user, and nothing leaves through loopback", () => {
    const comments = [...RULES.matchAll(/comment "([a-z-]+)"/g)].map(
      (match) => match[1],
    );

    expect(comments.sort()).toEqual(Object.keys(QUIET).sort());
    expect(RULES).toContain(`table inet ${GUARD_TABLE}`);
    expect(RULES).toContain(`add chain inet ${GUARD_TABLE} ${GUARD_CHAIN}`);
    // Loopback is the only way out that is accepted; everything else is counted and rejected.
    expect(RULES).toMatch(/oifname "lo" accept/);
    expect(RULES).not.toMatch(/\bdrop\b/);
    // The documentation range the controls use is reserved and never routed.
    expect(RULES).toContain(CONTROL_PREFIX.ipv4);
  });

  // #253-G04
  it("counts the users of the lane by number, including the engine user of the Dynamic image", () => {
    expect(RULES).toMatch(/meta skuid 10101 .*violation-engine/);
    expect(RULES).toMatch(/meta skuid 10001 .*violation-job/);
    expect(RULES).toMatch(/meta skuid 0 .*violation-root/);
    expect(RULES).toMatch(
      /meta skuid != \{ 0, 10001, 10101 \} .*violation-other/,
    );
  });

  it("is the same reading whatever the order of the rules", () => {
    const entries = Object.entries({ ...QUIET, "violation-job": 1 });
    const forward = parseGuard(listing(Object.fromEntries(entries)));
    const backward = parseGuard(
      listing(Object.fromEntries([...entries].reverse())),
    );

    expect(backward).toEqual(forward as GuardReading);
  });
});
