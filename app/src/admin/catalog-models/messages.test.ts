// SPDX-License-Identifier: Apache-2.0

// The copy of the catalog screens (#554): every stable code a route can answer with has a sentence, the guard's codes
// are those the fetch records, and a code the page does not know is never shown as it is.
import { describe, expect, it } from "vitest";
import { MODEL_PRICE_ROUTE_ERROR_CODES } from "../../model-prices/admin-errors.ts";
import { MANAGED_UNAVAILABLE_REASONS } from "../../model-prices/availability.ts";
import { PRICE_WARNINGS } from "../../model-prices/admin-view.ts";
import {
  PRICE_FIELDS,
  PRICE_SOURCES,
  PRICE_STATUSES,
} from "../../model-prices/effective-price.ts";
import { MODELS_DEV_ADMIN_ERROR_CODES } from "../../models-dev/admin-errors.ts";
import { GUARD_ERROR_CODES } from "../../models-dev/errors.ts";
import { URL_PROBLEMS, URL_STATES } from "../../models-dev/upstream-url.ts";
import { TRANSPORT_ERROR_CODES } from "../../ui/json-request.ts";
import {
  FETCH_ERROR_COPY,
  GUARD_CODES,
  MANAGED_REASON_COPY,
  PRICE_FIELD_LABEL,
  PRICE_SOURCE_LABEL,
  PRICE_STATUS_HELP,
  PRICE_STATUS_LABEL,
  PRICE_STATUS_ORDER,
  PRICE_WARNING_COPY,
  URL_PROBLEM_COPY,
  URL_STATE_LABEL,
  canRetry,
  describeCatalogError,
  describeIssue,
  isGuardCode,
  mustReload,
} from "./messages.ts";

describe("the copy of the stable codes", () => {
  // #554-T04
  it("has a sentence for every code a route of the catalog can answer with, and none shows the code", () => {
    const codes = new Set<string>([
      ...MODEL_PRICE_ROUTE_ERROR_CODES,
      ...MODELS_DEV_ADMIN_ERROR_CODES,
      ...TRANSPORT_ERROR_CODES,
    ]);

    for (const code of codes) {
      const text = describeCatalogError(code);
      expect(text, code).toMatch(/\S/);
      expect(text, code).not.toContain(code);
      expect(text, code).not.toBe(describeCatalogError("some_new_code"));
    }
  });

  // #554-T04
  it("says that a code it does not know was refused, without showing it", () => {
    expect(describeCatalogError("some_new_code")).toBe(
      "The change was refused. Reload the page and try again.",
    );
  });

  // #554-T04
  it("tells the codes of an unconfirmed price and a model that is not available apart from a name error", () => {
    expect(describeCatalogError("price_changed")).toMatch(/changed while you/);
    expect(describeCatalogError("fetch_in_progress")).toMatch(/Try again/);
    expect(describeIssue("negative")).toMatch(/negative/);
    expect(describeIssue("reason_invalid")).toMatch(/reason/);
  });

  // #554-T04
  it("knows which codes ask for a reload and which for another try", () => {
    expect(mustReload("price_changed")).toBe(true);
    expect(mustReload("url_changed_again")).toBe(true);
    expect(mustReload("model_blocked")).toBe(false);
    expect(canRetry("fetch_in_progress")).toBe(true);
    expect(canRetry("price_invalid")).toBe(false);
  });
});

describe("the copy of the statuses", () => {
  // #554-T01
  it("has a label and an explanation for every price status, every source, every field, every address state and problem", () => {
    for (const status of PRICE_STATUSES) {
      expect(PRICE_STATUS_LABEL[status]).toMatch(/\S/);
      expect(PRICE_STATUS_HELP[status]).toMatch(/\S/);
    }
    expect([...PRICE_STATUS_ORDER].sort()).toEqual([...PRICE_STATUSES].sort());
    for (const source of PRICE_SOURCES)
      expect(PRICE_SOURCE_LABEL[source]).toMatch(/\S/);
    for (const field of PRICE_FIELDS)
      expect(PRICE_FIELD_LABEL[field]).toMatch(/\S/);
    for (const state of URL_STATES)
      expect(URL_STATE_LABEL[state]).toMatch(/\S/);
    for (const problem of URL_PROBLEMS)
      expect(URL_PROBLEM_COPY[problem]).toMatch(/\S/);
    for (const warning of PRICE_WARNINGS)
      expect(PRICE_WARNING_COPY[warning]).toMatch(/\S/);
    for (const reason of MANAGED_UNAVAILABLE_REASONS)
      expect(MANAGED_REASON_COPY[reason]).toMatch(/\S/);
  });

  // #554-T08
  it("has a sentence for every code a fetch ends with", () => {
    for (const sentence of Object.values(FETCH_ERROR_COPY))
      expect(sentence).toMatch(/\S/);
  });

  // #548 review round: the guard code is translated
  it("treats exactly the codes of the fetch guard as the ones an admin may accept", () => {
    expect([...GUARD_CODES].sort()).toEqual(
      Object.values(GUARD_ERROR_CODES).sort(),
    );
    for (const code of GUARD_CODES) {
      expect(isGuardCode(code)).toBe(true);
      expect(FETCH_ERROR_COPY[code]).toMatch(/fetch/);
    }
    expect(isGuardCode("models_dev_timeout")).toBe(false);
  });
});
