// SPDX-License-Identifier: LicenseRef-Proprietary

// The links to the operator's terms and privacy statement (#626): which text is accepted as one, and how the stored setting reads.
import { describe, expect, it } from "vitest";
import {
  LEGAL_URL_MAX_LENGTH,
  readLegalUrls,
  validateLegalUrl,
} from "./legal-urls.ts";

describe("a link to the terms or the privacy statement", () => {
  // #626-T01
  it.each([
    "https://example.com/terms",
    "https://example.com/legal/terms?lang=en",
    "https://example.com:8443/terms#section-2",
    "https://8.8.8.8/terms",
  ])("accepts %s", (url) => {
    expect(validateLegalUrl(url)).toEqual({ ok: true, url });
  });

  // #626-T01
  it("trims the text around the address", () => {
    expect(validateLegalUrl("  https://example.com/terms \n")).toEqual({
      ok: true,
      url: "https://example.com/terms",
    });
  });

  // #626-T01
  it.each([
    ["http://example.com/terms", "not https"],
    ["javascript:alert(1)", "a script address"],
    ["//example.com/terms", "no scheme"],
    ["example.com/terms", "no scheme at all"],
    ["https://user:secret@example.com/terms", "credentials"],
    ["https://user@example.com/terms", "a user name"],
    ["https://localhost/terms", "a loopback name"],
    ["https://127.0.0.1/terms", "a loopback address"],
    ["https://10.0.0.5/terms", "a private address"],
    ["https://intranet/terms", "a name known on a private network only"],
    ["https://exa mple.com/terms", "a space inside"],
    ["https://example.com/te\nrms", "a line break inside"],
    ["https://example.com/te\u0000rms", "a control character"],
    ["", "nothing"],
    ["   ", "only spaces"],
    [`https://example.com/${"a".repeat(LEGAL_URL_MAX_LENGTH)}`, "too long"],
  ])("refuses %j (%s)", (text) => {
    expect(validateLegalUrl(text)).toEqual({ ok: false });
  });

  // #626-T01
  it("accepts an address at the length cap and refuses one past it", () => {
    const prefix = "https://example.com/";
    expect(
      validateLegalUrl(
        prefix + "a".repeat(LEGAL_URL_MAX_LENGTH - prefix.length),
      ).ok,
    ).toBe(true);
    expect(
      validateLegalUrl(
        prefix + "a".repeat(LEGAL_URL_MAX_LENGTH - prefix.length + 1),
      ).ok,
    ).toBe(false);
  });

  // #626-T01
  it.each([undefined, null, 3, {}, ["https://example.com"]])(
    "refuses %j, which is no text",
    (value) => {
      expect(validateLegalUrl(value)).toEqual({ ok: false });
    },
  );
});

describe("the stored links", () => {
  // #626-T02
  it("reads both links it finds", () => {
    expect(
      readLegalUrls({
        termsUrl: "https://example.com/terms",
        privacyUrl: "https://example.com/privacy",
      }),
    ).toEqual({
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
    });
  });

  // #626-T02
  it.each([
    [undefined, undefined],
    [null, undefined],
    ["https://example.com/terms", undefined],
    [[], undefined],
    [{}, undefined],
    [{ termsUrl: "http://example.com/terms" }, undefined],
    [{ termsUrl: 5, privacyUrl: "javascript:alert(1)" }, undefined],
    [
      {
        termsUrl: "http://example.com/terms",
        privacyUrl: "https://example.com/p",
      },
      { privacyUrl: "https://example.com/p" },
    ],
  ] as Array<[unknown, unknown]>)(
    "reads %j with a damaged link left out",
    (stored, expected) => {
      expect(readLegalUrls(stored)).toEqual(expected);
    },
  );
});
