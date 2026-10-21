// SPDX-License-Identifier: Apache-2.0

// The billing profile of a workspace, as input (ADR 0006, 2.13; #501): the legal name and address of the business that
// buys credit and an optional VAT ID. Pure: it validates what a person typed and says which FIELD is wrong with a stable
// code, never with the value (the profile is customer data and is not logged, quoted or echoed in an error).
//
// The VAT ID check is LIGHT on purpose: the right shape for the country (`DE` and nine digits), nothing more. It is
// never a claim that the number is valid or belongs to the business; only a tax authority can say that (VIES), and the
// product promises no VAT-compliant invoice yet (ADR 0006, 2.17). A country without a shape here (outside the EU, Great
// Britain, Norway and Switzerland) takes no VAT ID in v1: the field stays empty.
import "server-only";

/** The version of the business terms the confirmation at the first top-up refers to; bumped when the terms change. */
export const BILLING_TERMS_VERSION = "2026-10";

export const BILLING_PROFILE_FIELDS = [
  "legalName",
  "country",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "vatId",
] as const;
export type BillingProfileField = (typeof BILLING_PROFILE_FIELDS)[number];

export const BILLING_PROFILE_ISSUE_CODES = [
  /** A required field is empty, missing or not text. */
  "required",
  "too_long",
  /** A control character (a line break, a tab) or text that is not a string. */
  "invalid_characters",
  /** Not a two-letter ISO 3166 country code we know. */
  "country_unknown",
  /** The VAT ID does not have the shape of the country's. */
  "vat_id_invalid",
  /** v1 has no VAT ID shape for this country: leave the field empty. */
  "vat_country_unsupported",
] as const;
export type BillingProfileIssueCode =
  (typeof BILLING_PROFILE_ISSUE_CODES)[number];

export type BillingProfileIssue = {
  field: BillingProfileField;
  code: BillingProfileIssueCode;
};

/** A validated, trimmed profile. The country is upper case; the VAT ID is normalized (no spaces, dots or dashes). */
export type BillingProfileInput = {
  legalName: string;
  country: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  vatId: string | null;
};

export type BillingProfileValidation =
  | { ok: true; value: BillingProfileInput }
  | { ok: false; issues: BillingProfileIssue[] };

/** Stripe takes up to 256 characters of a name and 200 of an address line; one limit below both keeps it simple. */
const MAX_LENGTH: Record<
  Exclude<BillingProfileField, "country" | "vatId">,
  number
> = {
  legalName: 200,
  addressLine1: 200,
  addressLine2: 200,
  postalCode: 20,
  city: 100,
};
const MAX_VAT_ID_INPUT_LENGTH = 40;

/** ISO 3166-1 alpha-2, the codes Stripe takes for an address. */
export const BILLING_COUNTRY_CODES: readonly string[] = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
];
const COUNTRIES: ReadonlySet<string> = new Set(BILLING_COUNTRY_CODES);

/**
 * The shape of a normalized VAT ID by country (prefix included). The EU's prefix is the country code, except Greece
 * (`EL`). Great Britain, Norway and Switzerland are the three non-EU countries Stripe has a tax id type for.
 */
const VAT_ID_SHAPE: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  GR: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  GB: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  NO: /^NO\d{9}MVA$/,
  CH: /^CHE\d{9}(MWST|TVA|IVA)$/,
};

/** Upper case, without spaces, dots, dashes or slashes: the one form a VAT ID is compared, checked and sent in. */
export function normalizeVatId(raw: string): string {
  return raw.replace(/[\s.\-/]/g, "").toUpperCase();
}

type TextResult =
  { ok: true; value: string } | { ok: false; code: BillingProfileIssueCode };

/** A text field, trimmed. Empty is the caller's decision (`required`, or "not given"). */
function readText(raw: unknown, maxLength: number): TextResult {
  if (typeof raw !== "string") return { ok: false, code: "required" };
  const value = raw.trim();
  if (value.length > maxLength) return { ok: false, code: "too_long" };
  // Control characters (a line break, a tab), the Unicode line and paragraph separators and the format characters (a
  // right-to-left override, a zero-width space, a byte order mark) have no place in a name: the text is printed on an invoice.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    return { ok: false, code: "invalid_characters" };
  return { ok: true, value };
}

/**
 * Validates a profile body. Unknown fields are ignored (the confirmation is never taken from the body). Every wrong field
 * is listed, in the order of `BILLING_PROFILE_FIELDS`; an empty VAT ID and no second address line are fine.
 */
export function validateBillingProfileInput(
  body: unknown,
): BillingProfileValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {
      ok: false,
      issues: BILLING_PROFILE_FIELDS.map((field) => ({
        field,
        code: "required" as const,
      })),
    };
  const input = body as Record<string, unknown>;
  const issues: BillingProfileIssue[] = [];
  const refuse = (field: BillingProfileField, code: BillingProfileIssueCode) =>
    issues.push({ field, code });

  const required = (
    field: Exclude<BillingProfileField, "country" | "vatId" | "addressLine2">,
  ): string => {
    const text = readText(input[field], MAX_LENGTH[field]);
    if (!text.ok) {
      // Text that is not a string is a missing field; a string with a bad character or a length keeps its own code.
      refuse(field, text.code);
      return "";
    }
    if (text.value === "") {
      refuse(field, "required");
      return "";
    }
    return text.value;
  };

  const legalName = required("legalName");

  let country = "";
  if (typeof input.country === "string") {
    const candidate = input.country.trim().toUpperCase();
    if (COUNTRIES.has(candidate)) country = candidate;
  }
  if (country === "") refuse("country", "country_unknown");

  const addressLine1 = required("addressLine1");

  let addressLine2: string | null = null;
  const second = input.addressLine2;
  if (second !== undefined && second !== null) {
    const text =
      typeof second === "string"
        ? readText(second, MAX_LENGTH.addressLine2)
        : ({ ok: false, code: "invalid_characters" } as const);
    if (!text.ok) refuse("addressLine2", text.code);
    else addressLine2 = text.value === "" ? null : text.value;
  }

  const postalCode = required("postalCode");
  const city = required("city");

  let vatId: string | null = null;
  const rawVat = input.vatId;
  if (rawVat !== undefined && rawVat !== null) {
    if (typeof rawVat !== "string") refuse("vatId", "vat_id_invalid");
    else if (rawVat.length > MAX_VAT_ID_INPUT_LENGTH)
      refuse("vatId", "too_long");
    else if (rawVat.trim() !== "") {
      const normalized = normalizeVatId(rawVat);
      const shape = VAT_ID_SHAPE[country];
      // Without a known country there is nothing to check the number against: the country is the issue already.
      if (country === "") vatId = null;
      else if (shape === undefined) refuse("vatId", "vat_country_unsupported");
      else if (!shape.test(normalized)) refuse("vatId", "vat_id_invalid");
      else vatId = normalized;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      legalName,
      country,
      addressLine1,
      addressLine2,
      postalCode,
      city,
      vatId,
    },
  };
}
