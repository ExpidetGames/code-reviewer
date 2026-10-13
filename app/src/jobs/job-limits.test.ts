// SPDX-License-Identifier: Apache-2.0

// #195 finding 1: the operator owns the deadline after which a job no capable runner claims is
// cancelled. A missing or unusable value must keep the default, so a typo never disables the bound.
import { describe, expect, it } from "vitest";
import {
  configuredNoCapableRunnerMs,
  DEFAULT_NO_CAPABLE_RUNNER_MS,
  NO_CAPABLE_RUNNER_VARIABLE,
} from "./job-limits.ts";

describe("the no-capable-runner deadline", () => {
  it("reads seconds from the operator variable", () => {
    expect(
      configuredNoCapableRunnerMs({ [NO_CAPABLE_RUNNER_VARIABLE]: "600" }),
    ).toBe(600_000);
  });

  it.each([undefined, "", "  ", "soon", "0", "-5", "NaN"])(
    "keeps the default for %s",
    (value) => {
      expect(
        configuredNoCapableRunnerMs({ [NO_CAPABLE_RUNNER_VARIABLE]: value }),
      ).toBe(DEFAULT_NO_CAPABLE_RUNNER_MS);
    },
  );
});
