// SPDX-License-Identifier: Apache-2.0

// The links to the operator's terms and privacy statement (#626): two instance settings of the billing page of the admin portal,
// `billing_settings.legal`. The terms link is what the business confirmation of the first top-up points to, and the Stripe
// adapter is not ready without it (`terms_url_missing`, readiness.ts); the privacy link is optional. A link is shown to every
// buyer as an `href`, so what is stored is checked twice: when the admin saves it and when it is read (a value that was written
// by another path, or an older release, and does not pass reads as not set). Pure: no database.
import "server-only";
import { isPublicHttpsUrl } from "./public-url.ts";

/** The longest link; the address bar of every browser takes more, a legal page needs far less. */
export const LEGAL_URL_MAX_LENGTH = 2048;

export type LegalUrls = {
  /** The terms of the operator, which the business confirmation links to. */
  termsUrl?: string;
  privacyUrl?: string;
};

export type LegalUrlCheck = { ok: true; url: string } | { ok: false };

// A space or a control character inside the text: the URL parser drops tabs and line breaks silently, so the address that is
// stored would not be the one that was checked.
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

/**
 * An `https` address of a public host with no credentials (the rule of `isPublicHttpsUrl`), at most `LEGAL_URL_MAX_LENGTH`
 * characters, with no space or control character in it. The text is trimmed; the address is kept as written.
 */
export function validateLegalUrl(value: unknown): LegalUrlCheck {
  if (typeof value !== "string") return { ok: false };
  const url = value.trim();
  if (url === "" || url.length > LEGAL_URL_MAX_LENGTH) return { ok: false };
  if (WHITESPACE_OR_CONTROL.test(url)) return { ok: false };
  return isPublicHttpsUrl(url) ? { ok: true, url } : { ok: false };
}

/** The stored links; a link that does not pass `validateLegalUrl` reads as not set. Undefined when none is set. */
export function readLegalUrls(stored: unknown): LegalUrls | undefined {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return undefined;
  const { termsUrl, privacyUrl } = stored as Record<string, unknown>;
  const terms = validateLegalUrl(termsUrl);
  const privacy = validateLegalUrl(privacyUrl);
  const legal: LegalUrls = {
    ...(terms.ok ? { termsUrl: terms.url } : {}),
    ...(privacy.ok ? { privacyUrl: privacy.url } : {}),
  };
  return Object.keys(legal).length === 0 ? undefined : legal;
}
