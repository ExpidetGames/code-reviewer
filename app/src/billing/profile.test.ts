// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BILLING_COUNTRY_CODES,
  normalizeVatId,
  validateBillingProfileInput,
  type BillingProfileInput,
} from "./profile.ts";

const valid: Record<string, unknown> = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: "c/o Example",
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
};

function accepted(input: Record<string, unknown>): BillingProfileInput {
  const result = validateBillingProfileInput(input);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function issuesOf(input: Record<string, unknown>) {
  const result = validateBillingProfileInput(input);
  if (result.ok) throw new Error("accepted");
  return result.issues;
}

describe("the billing profile input", () => {
  it("accepts a complete profile and trims and normalizes it", () => {
    expect(
      accepted({
        ...valid,
        legalName: "  Example GmbH ",
        country: "de",
        vatId: " de 123.456-789 ",
      }),
    ).toEqual({
      legalName: "Example GmbH",
      country: "DE",
      addressLine1: "Teststrasse 1",
      addressLine2: "c/o Example",
      postalCode: "10115",
      city: "Berlin",
      vatId: "DE123456789",
    });
  });

  // #501-T12
  it("allows an empty VAT ID and no second address line", () => {
    for (const vatId of ["", "   ", null, undefined]) {
      const value = accepted({ ...valid, vatId, addressLine2: "" });
      expect(value.vatId).toBeNull();
      expect(value.addressLine2).toBeNull();
    }
  });

  // #501-T12
  it("refuses a VAT ID of a wrong format with a field code", () => {
    for (const vatId of [
      "123",
      "DE",
      "DE12",
      "DE12$%&/()",
      "FR123456789",
      "DE1234567890123456",
    ])
      expect(issuesOf({ ...valid, vatId })).toEqual([
        { field: "vatId", code: "vat_id_invalid" },
      ]);
  });

  // #501-T12
  it("refuses an unknown country, and a VAT ID of a country it has no format for", () => {
    for (const country of ["XX", "DEU", "", "1", "Germany", 5, null])
      expect(issuesOf({ ...valid, country, vatId: "" })).toEqual([
        { field: "country", code: "country_unknown" },
      ]);
    expect(issuesOf({ ...valid, country: "US", vatId: "123456789" })).toEqual([
      { field: "vatId", code: "vat_country_unsupported" },
    ]);
    expect(accepted({ ...valid, country: "US", vatId: "" }).vatId).toBeNull();
  });

  it("checks the VAT ID against the country, with the Greek prefix EL", () => {
    expect(
      accepted({ ...valid, country: "GR", vatId: "EL123456789" }).vatId,
    ).toBe("EL123456789");
    expect(issuesOf({ ...valid, country: "GR", vatId: "GR123456789" })).toEqual(
      [{ field: "vatId", code: "vat_id_invalid" }],
    );
    expect(
      accepted({ ...valid, country: "GB", vatId: "GB123456789" }).vatId,
    ).toBe("GB123456789");
    expect(
      accepted({ ...valid, country: "NO", vatId: "NO123456789MVA" }).vatId,
    ).toBe("NO123456789MVA");
    expect(
      accepted({ ...valid, country: "CH", vatId: "CHE-123.456.789 MWST" })
        .vatId,
    ).toBe("CHE123456789MWST");
  });

  it("refuses a missing or empty required field, a non-text value and a control character", () => {
    for (const field of [
      "legalName",
      "addressLine1",
      "postalCode",
      "city",
    ] as const) {
      expect(issuesOf({ ...valid, [field]: "" })).toEqual([
        { field, code: "required" },
      ]);
      expect(issuesOf({ ...valid, [field]: undefined })).toEqual([
        { field, code: "required" },
      ]);
      expect(issuesOf({ ...valid, [field]: 5 })).toEqual([
        { field, code: "required" },
      ]);
      expect(issuesOf({ ...valid, [field]: "a\nb" })).toEqual([
        { field, code: "invalid_characters" },
      ]);
      expect(issuesOf({ ...valid, [field]: "x".repeat(300) })).toEqual([
        { field, code: "too_long" },
      ]);
    }
  });

  // #501-T16
  it("refuses format characters in a name or an address: a right-to-left override, a zero-width space, a soft hyphen, a byte order mark", () => {
    for (const field of [
      "legalName",
      "addressLine1",
      "addressLine2",
      "postalCode",
      "city",
    ] as const)
      for (const character of [
        "\u202E",
        "\u200B",
        "\u00AD",
        "\uFEFF",
        "\u2066",
      ])
        expect(
          issuesOf({ ...valid, [field]: `Ex${character}ample` }),
          `${field} U+${character.codePointAt(0)!.toString(16)}`,
        ).toEqual([{ field, code: "invalid_characters" }]);
    // Ordinary letters of other scripts and punctuation stay.
    expect(
      validateBillingProfileInput({
        ...valid,
        legalName: "Müller & Söhne — Zürich GmbH",
        city: "São Paulo",
      }),
    ).toMatchObject({ ok: true });
  });

  // #501-T16
  it("does not take a VAT ID that carries a format character", () => {
    expect(issuesOf({ ...valid, vatId: "DE123\u200B456789" })).toEqual([
      { field: "vatId", code: "vat_id_invalid" },
    ]);
  });

  it("refuses a body that is not an object, and lists every bad field", () => {
    for (const body of [null, "x", 5, [], undefined])
      expect(validateBillingProfileInput(body)).toMatchObject({ ok: false });
    expect(
      issuesOf({ ...valid, legalName: "", city: "", vatId: "nonsense" }).map(
        (issue) => issue.field,
      ),
    ).toEqual(["legalName", "city", "vatId"]);
  });

  it("ignores fields it does not know", () => {
    expect(
      accepted({ ...valid, confirmedAt: "2020-01-01", extra: 1 }),
    ).not.toHaveProperty("confirmedAt");
  });
});

describe("normalizeVatId", () => {
  it("upper-cases and drops spaces, dots, dashes and slashes", () => {
    expect(normalizeVatId(" nl 8123.45.678-b01 ")).toBe("NL812345678B01");
  });
});

describe("the country list", () => {
  it("holds two-letter upper case codes, each once", () => {
    expect(new Set(BILLING_COUNTRY_CODES).size).toBe(
      BILLING_COUNTRY_CODES.length,
    );
    for (const code of BILLING_COUNTRY_CODES)
      expect(code).toMatch(/^[A-Z]{2}$/);
    for (const code of ["DE", "FR", "US", "GB", "CH", "AT", "NL"])
      expect(BILLING_COUNTRY_CODES).toContain(code);
  });
});
