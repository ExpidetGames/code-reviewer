// SPDX-License-Identifier: LicenseRef-Proprietary

// The two sets of codes of the binding (the person's flow, the instance admin's decision) share some codes. A
// client that branches on the HTTP status must get the same status for the same code on every route.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ERROR_CODES,
  APPROVAL_ERROR_STATUS,
  BINDING_ERROR_CODES,
  BINDING_ERROR_STATUS,
} from "./errors.ts";

describe("the HTTP status of a code", () => {
  // #103-IB-20
  it("is the same on every route that can answer the code", () => {
    const shared = APPROVAL_ERROR_CODES.filter((code) =>
      (BINDING_ERROR_CODES as readonly string[]).includes(code),
    );

    expect(shared).toContain("installation_not_accessible");
    for (const code of shared)
      expect(APPROVAL_ERROR_STATUS[code], `${code} has two statuses`).toBe(
        BINDING_ERROR_STATUS[code as keyof typeof BINDING_ERROR_STATUS],
      );
  });
});
