// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CLAIM_FAILURE_CODES,
  CLAIM_RELEASE_REASONS,
} from "../runner-api/claim.ts";
import { RUNNER_ERROR_CODES } from "../runner-api/contract.ts";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import {
  describeErrorCode,
  ERROR_COPY,
  UNKNOWN_ERROR_COPY,
} from "./error-copy.ts";

const ALL_CODES = [
  ...new Set<string>([
    ...JOB_ERROR_CODES,
    ...CLAIM_FAILURE_CODES,
    ...CLAIM_RELEASE_REASONS,
    ...RUNNER_ERROR_CODES,
  ]),
];

describe("the sentences for error codes", () => {
  // CR-35-T08
  it("has a sentence for every code the queue, the claim and the runner can store", () => {
    const missing = ALL_CODES.filter(
      (code) => !Object.hasOwn(ERROR_COPY, code),
    );

    expect(missing).toEqual([]);
  });

  // CR-35-T08
  it("explains each code in a full sentence that is not the code itself", () => {
    for (const code of ALL_CODES) {
      const { text, known } = describeErrorCode(code);
      expect(known).toBe(true);
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toContain(code);
      expect(text).not.toBe(UNKNOWN_ERROR_COPY);
    }
  });

  // #200: the codes a Dynamic project's run can end with are read by people on the Runs pages.
  it("tells a person what to do about a Dynamic Review that is not enabled, and about a model the engine cannot use", () => {
    expect(describeErrorCode("dynamic_review_disabled").text).toMatch(
      /instance|server/i,
    );
    expect(describeErrorCode("dynamic_review_disabled").text).toMatch(
      /Diff Review/,
    );
    expect(describeErrorCode("no_capable_runner").text).toMatch(/runner/);
    expect(
      describeErrorCode("dynamic_model_features_unsupported").text,
    ).toMatch(/Choose another model/);
    expect(describeErrorCode("dynamic_config_invalid").text).toMatch(
      /project page/,
    );
  });

  it("has no sentence for a code that does not exist", () => {
    const extra = Object.keys(ERROR_COPY).filter(
      (code) => !ALL_CODES.includes(code),
    );

    expect(extra).toEqual([]);
  });

  // CR-35-T09
  it("gives an unknown code a general sentence and shows the code besides it", () => {
    expect(describeErrorCode("flux_capacitor_overload")).toEqual({
      code: "flux_capacitor_overload",
      text: UNKNOWN_ERROR_COPY,
      known: false,
    });
  });

  // CR-35-T09
  it("never shows something that is not shaped like a code", () => {
    for (const odd of [
      "<script>alert(1)</script>",
      "Has Spaces",
      "",
      "x".repeat(65),
      "toString",
    ]) {
      const described = describeErrorCode(odd);
      expect(described.known).toBe(false);
      expect(described.text).toBe(UNKNOWN_ERROR_COPY);
    }
    expect(describeErrorCode("<script>").code).toBeNull();
    expect(describeErrorCode("").code).toBeNull();
  });
});
