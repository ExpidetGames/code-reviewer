// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { CATALOG_ROUTE_ERROR_CODES } from "../../model-catalog/admin-errors.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import {
  describeCatalogFailure,
  describeCatalogIssue,
} from "./catalog-messages.ts";

describe("the copy for the catalog's stable codes", () => {
  // #429-T03
  it.each(CATALOG_ROUTE_ERROR_CODES)(
    "has a sentence of its own for %s, which is not the code",
    (code) => {
      const sentence = describeCatalogFailure(code);

      expect(sentence).not.toBe(GENERIC_FAILURE);
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toContain(code);
      expect(sentence).toMatch(/[.!?]$/);
    },
  );

  // #429-T03
  it("has a sentence for the problem of a field, whatever the code the server gives it", () => {
    for (const code of CATALOG_ROUTE_ERROR_CODES) {
      const sentence = describeCatalogIssue({ field: "name", code });
      expect(sentence.length, code).toBeGreaterThan(20);
      expect(sentence, code).not.toContain(code);
    }
  });

  it("falls back to the generic sentence for a code it does not know, and says nothing of it", () => {
    expect(describeCatalogFailure("something_new")).toBe(GENERIC_FAILURE);
    expect(describeCatalogIssue({ field: "x", code: "something_new" })).toBe(
      GENERIC_FAILURE,
    );
  });

  it("translates the transport failures like the other pages do", () => {
    expect(describeCatalogFailure("NETWORK_ERROR")).not.toBe(GENERIC_FAILURE);
    expect(describeCatalogFailure("UNAUTHENTICATED")).not.toBe(GENERIC_FAILURE);
  });
});
