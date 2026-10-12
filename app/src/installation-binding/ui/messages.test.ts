// SPDX-License-Identifier: Apache-2.0

// Pins down the words of the binding: every code a page can be told has a sentence, a refusal is worded as one
// and nothing worded here names another workspace, a token or an address of GitHub.
import { describe, expect, it } from "vitest";
import {
  BINDING_ERROR_CODES,
  BINDING_RESULT_CODES,
  BINDING_WAITING_CODES,
  isBindingResultCode,
} from "../errors.ts";
import { ROLE_RESULTS } from "../requests.ts";
import {
  APPROVAL_FAILURE_COPY,
  describeApprovalFailure,
  describeBindingFailure,
  describeResultCode,
  describeRoleDetail,
  RESULT_COPY,
  ROLE_RESULT_COPY,
} from "./messages.ts";

describe("the copy of the binding", () => {
  // #103-IB-04
  it("has a sentence for every code a flow can end with, and only the refusals are errors", () => {
    for (const code of BINDING_RESULT_CODES) {
      const copy = RESULT_COPY[code];
      expect(copy.text.length, code).toBeGreaterThan(20);
      expect(copy.text, code).not.toMatch(/\bundefined\b|workspace-|token/i);
    }
    for (const code of BINDING_ERROR_CODES)
      expect(RESULT_COPY[code].tone, code).toBe("error");
    for (const code of BINDING_WAITING_CODES)
      expect(RESULT_COPY[code].tone, code).toBe("info");
    expect(RESULT_COPY.linked.tone).toBe("success");
  });

  // #103-IB-16
  it("only knows the codes of its own list: anything else a query says is nothing", () => {
    expect(describeResultCode("<script>")).toBeNull();
    expect(describeResultCode("toString")).toBeNull();
    expect(isBindingResultCode("linked")).toBe(true);
    expect(isBindingResultCode("https://evil.example")).toBe(false);
  });

  // #103-IB-09
  it("words a failed call by its code, by the transport failures, and generically", () => {
    expect(describeBindingFailure("rate_limited")).toMatch(/Too many attempts/);
    expect(describeBindingFailure("forbidden")).toMatch(/does not allow/);
    expect(describeBindingFailure("NETWORK_ERROR")).toMatch(
      /could not be reached/,
    );
    expect(describeBindingFailure("something_new")).toMatch(
      /Something went wrong/,
    );
  });

  // #103-IB-23
  it("words the evidence of a request for every role result, and the reasons it knows", () => {
    for (const result of ROLE_RESULTS)
      expect(ROLE_RESULT_COPY[result].length, result).toBeGreaterThan(5);
    expect(describeRoleDetail("forbidden")).toMatch(
      /organization permission Members/,
    );
    expect(describeRoleDetail("nothing-known")).toBeNull();
    expect(describeRoleDetail(null)).toBeNull();
  });

  // #103-IB-20
  it("words each refusal of a decision, and falls back for one it does not know", () => {
    for (const code of Object.keys(APPROVAL_FAILURE_COPY))
      expect(describeApprovalFailure(code)).toBe(APPROVAL_FAILURE_COPY[code]);
    expect(describeApprovalFailure("NETWORK_ERROR")).toMatch(
      /could not be reached/,
    );
    expect(describeApprovalFailure("other")).toMatch(/Something went wrong/);
  });
});
