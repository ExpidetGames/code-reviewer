// SPDX-License-Identifier: LicenseRef-Proprietary

// What the check run and the verdict read from the result a job stored (#405). The result was checked when it was
// reported, but rows of earlier releases and rows changed by hand exist, so every field is checked again and
// anything that is not what it should be is "not said", never an error.
import { describe, expect, it } from "vitest";
import { readResultFacts } from "./result-facts.ts";

const GOOD = {
  ok: true,
  commentUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1",
  findings: { open: 3, bySeverity: { P0: 1, P1: 0, P2: 2, P3: 0 } },
  usage: { stoppedEarly: "cost_limit", aiCalls: 4 },
};

describe("the facts of a stored result", () => {
  it("reads the link, the open findings and why the review stopped early", () => {
    expect(readResultFacts(GOOD)).toEqual({
      commentUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1",
      findings: { open: 3, bySeverity: { P0: 1, P1: 0, P2: 2, P3: 0 } },
      stoppedEarly: "cost_limit",
      modelCalls: 4,
    });
  });

  // #405-T30 (review P1-3)
  it("reads that the review did not cover everything", () => {
    expect(
      readResultFacts({
        findings: { open: 0, bySeverity: null, incomplete: true },
      }).findings,
    ).toEqual({ open: 0, bySeverity: null, incomplete: true });
    expect(
      readResultFacts({
        findings: { open: 0, bySeverity: null, incomplete: false },
      }).findings,
    ).toEqual({ open: 0, bySeverity: null });
    expect(
      readResultFacts({
        findings: { open: 0, bySeverity: null, incomplete: "yes" },
      }).findings,
    ).toBeNull();
  });

  it("reads no model calls when the usage is missing or not a count", () => {
    expect(readResultFacts({ usage: null }).modelCalls).toBeNull();
    expect(readResultFacts({ usage: { aiCalls: -1 } }).modelCalls).toBeNull();
    expect(readResultFacts({ usage: { aiCalls: 0 } }).modelCalls).toBe(0);
  });

  it("reads the findings of a Diff review, which have no breakdown", () => {
    expect(
      readResultFacts({ findings: { open: 2, bySeverity: null } }).findings,
    ).toEqual({ open: 2, bySeverity: null });
  });

  // #405-T19
  it("knows nothing of a result without findings, as every result before this feature", () => {
    expect(readResultFacts({ ok: true, usage: null })).toEqual({
      commentUrl: null,
      findings: null,
      stoppedEarly: null,
      modelCalls: null,
    });
  });

  it.each([
    ["no result", null],
    ["a number", 5],
    ["a list", []],
    ["a string", "text"],
  ])("knows nothing of %s", (_name, result) => {
    expect(readResultFacts(result)).toEqual({
      commentUrl: null,
      findings: null,
      stoppedEarly: null,
      modelCalls: null,
    });
  });

  it.each([
    ["a negative count", { open: -1, bySeverity: null }],
    ["a count that is not whole", { open: 1.5, bySeverity: null }],
    ["a missing breakdown field", { open: 1 }],
    [
      "a breakdown with a missing priority",
      { open: 1, bySeverity: { P0: 1, P1: 0, P2: 0 } },
    ],
    [
      "a breakdown with a text",
      { open: 1, bySeverity: { P0: "1", P1: 0, P2: 0, P3: 0 } },
    ],
  ])("does not trust findings with %s", (_name, findings) => {
    expect(readResultFacts({ findings }).findings).toBeNull();
  });

  it("ignores a link that is not text and a reason it does not know", () => {
    expect(
      readResultFacts({ commentUrl: 5, usage: { stoppedEarly: "boredom" } }),
    ).toEqual({
      commentUrl: null,
      findings: null,
      stoppedEarly: null,
      modelCalls: null,
    });
  });
});
