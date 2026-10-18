// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CLAIM_FAILURE_CODES,
  CLAIM_RELEASE_REASONS,
} from "../runner-api/claim.ts";
import {
  RUNNER_CHECKOUT_REASONS,
  RUNNER_ERROR_CODES,
} from "../runner-api/contract.ts";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import {
  CHECKOUT_REASON_COPY,
  describeCheckoutReason,
  describeErrorCode,
  ERROR_COPY,
  HISTORIC_ERROR_CODES,
  UNKNOWN_ERROR_COPY,
  UNKNOWN_REASON_COPY,
} from "./error-copy.ts";

const ALL_CODES = [
  ...new Set<string>([
    ...JOB_ERROR_CODES,
    ...CLAIM_FAILURE_CODES,
    ...CLAIM_RELEASE_REASONS,
    ...RUNNER_ERROR_CODES,
    ...HISTORIC_ERROR_CODES,
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

  // #434-T07: the code no part of the system produces any more, kept for the runs that ended with it.
  it("keeps the sentence of the removed tier code for old runs, points at the review options that replaced the levels, and the claim cannot end a job with it", () => {
    const code = "managed_tier_unavailable";
    const { text, known } = describeErrorCode(code);

    expect(HISTORIC_ERROR_CODES).toEqual([code]);
    expect(CLAIM_FAILURE_CODES).not.toContain(code);
    expect(known).toBe(true);
    expect(text).toMatch(/quality level/);
    expect(text).toMatch(/replaced/);
    expect(text).toMatch(/Owner or Admin/);
    expect(text).toMatch(/review settings/);
    expect(text).not.toMatch(/\bmodel\b(?! was used)/);
  });

  // #432-T19
  it("tells a person about an unavailable model choice without naming a model, and where to change it", () => {
    expect(CLAIM_FAILURE_CODES).toContain("managed_model_unavailable");
    const { text, known } = describeErrorCode("managed_model_unavailable");

    expect(known).toBe(true);
    expect(text).toMatch(/Owner or Admin/);
    expect(text).toMatch(/review settings/);
    expect(text).toMatch(/whoever runs this instance/);
    expect(text).toMatch(/no AI model was used/);
    expect(text).not.toMatch(/\bmodel\b(?! was used)/);
  });

  // #432-T19
  it("tells a person that the runner cannot use the provider chosen for the project, naming no provider", () => {
    expect(CLAIM_FAILURE_CODES).toContain("llm_provider_unsupported");
    const { text, known } = describeErrorCode("llm_provider_unsupported");

    expect(known).toBe(true);
    expect(text).toMatch(/no AI model was used/);
    expect(text).toMatch(/model settings/);
    expect(text).not.toMatch(/openrouter/i);
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

  // #432-T22
  it("tells the user of a Dynamic Review that the Dynamic model counts as a model setting, without naming a model", () => {
    const { text } = describeErrorCode("job_llm_options_invalid");

    expect(text).toMatch(/Dynamic model/);
    expect(text).toMatch(/project page/);
  });

  // #277-T12
  it("explains a refusal for the plan of the workspace in one sentence, without a number or a figure", () => {
    for (const code of [
      "workspace_suspended",
      "quota_exhausted",
      "entitlements_invalid",
    ]) {
      const { text, known } = describeErrorCode(code);

      expect(known).toBe(true);
      expect(text).toMatch(/^[A-Z][^.]*\.(?: [A-Z][^.]*\.)*$/);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[$€£%]/);
      expect(text).toMatch(/did not start/);
      expect(text).toMatch(/no AI model was used/);
    }
  });

  // #290-T06
  it("tells a person that the request was larger than the model's context window", () => {
    const { text, known } = describeErrorCode("llm_context_length_exceeded");

    expect(known).toBe(true);
    expect(text).toMatch(/context window/);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toContain("llm_context_length_exceeded");
  });

  // #260: the code is also reported when the app could not be asked, not only when the job was lost.
  it("says for lease_lost that the job may have been lost or that this could not be confirmed, and that nothing was written", () => {
    const { text } = describeErrorCode("lease_lost");

    expect(text).toMatch(/no longer held/);
    expect(text).toMatch(/could not be confirmed/);
    expect(text).toMatch(/nothing was written/);
  });

  // #201-T20
  it("does not say the engine ran when review_not_published can come from the preparation", () => {
    const { text } = describeErrorCode("review_not_published");

    // The Dynamic preparation raises this code before any engine starts, when the earlier review
    // on the pull request cannot be used as the starting point.
    expect(text).not.toMatch(/engine finished/i);
    expect(text).toMatch(/earlier review/i);
    expect(text).toMatch(/no review was posted/i);
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

  // #296-T11
  it("has a full sentence for every reason the checkout can fail with", () => {
    for (const reason of RUNNER_CHECKOUT_REASONS) {
      expect(Object.hasOwn(CHECKOUT_REASON_COPY, reason)).toBe(true);
      const description = describeCheckoutReason(reason);
      expect(description).toStrictEqual({
        code: reason,
        text: CHECKOUT_REASON_COPY[reason],
        known: true,
      });
      expect(description?.text).toMatch(/^[A-Z].*\.$/);
      expect(description?.text).not.toContain(reason);
    }
  });

  // #296-T11
  it("shows a reason it does not know with the general sentence, and one that is not shaped like a code not at all", () => {
    expect(describeCheckoutReason("brand_new_reason")).toStrictEqual({
      code: "brand_new_reason",
      text: UNKNOWN_REASON_COPY,
      known: false,
    });
    expect(describeCheckoutReason("<script>alert(1)</script>")).toBeNull();
    expect(describeCheckoutReason("")).toBeNull();
  });
});
