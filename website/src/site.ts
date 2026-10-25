// SPDX-License-Identifier: LicenseRef-Proprietary

// Settings of the code-review.com landing page (from the Itegro template, see README.md and AGENTS.md).

import { COMPANY } from "./content/company";

/** Production URL with https and without a trailing slash. Sets canonical, sitemap, RSS and structured data. */
export const SITE_URL = "https://code-review.com";

/** The product name. The page title is "Page title | NAME". Always lowercase, also at the start of a sentence. */
export const NAME = "code-review.com";

/** One sentence: fallback description of pages without their own, and the intro of llms.txt. */
export const DESCRIPTION =
  "Simple code reviews for every GitHub pull request. Built on PR-Agent and OpenCode, with the AI models included. A hosted service by Itegro GmbH.";

/** Language of the site (BCP 47) and locale for Open Graph. The copy is English; the legal texts also have a German version. */
export const LANG = "en";
export const LOCALE = "en_US";

/** Default author of blog articles without their own `author`. */
export const DEFAULT_AUTHOR = "Itegro GmbH";

/** Publisher, appears as Organization in the structured data. */
export const ORGANIZATION = {
  name: COMPANY.name,
  url: COMPANY.web,
  email: COMPANY.email,
  telephone: COMPANY.phone,
  address: {
    streetAddress: COMPANY.street,
    postalCode: COMPANY.postalCode,
    addressLocality: COMPANY.city,
    addressCountry: "DE",
  },
  founders: [...COMPANY.managingDirectors],
  sameAs: [] as string[],
};

/**
 * Imprint, privacy policy and terms are final and reviewed. While this is false they are noindex and missing
 * from the sitemap. true because the legal texts are the existing, reviewed ones of the Next.js site.
 */
export const LEGAL_READY = true;

// --- Tracking (PostHog main project, see src/lib/analytics.ts) ----------------------------------------

/** Identifier of this site in the PostHog main project. Every event carries it as `site`. */
export const SITE = "code-review";

/** Subdomains sharing one cookie. Not used: the app (app.code-review.com) gets the ids through CROSS_DOMAINS instead. */
export const SHARED_COOKIE_DOMAIN: string | null = null;

/**
 * Other domains this site links to, whose links get the visitor and session id appended when they are opened
 * (consented visitors only, process "Landingpages" step 6, case B):
 * - itegro-gmbh.de: the Itegro landing page, same PostHog main project.
 * - app.code-review.com: the hosted app. Its sign-up and login pages read `ph_did` and `ph_sid` and store them
 *   with a new account (first touch). The app runs no analytics SDK, so this is a hand-over, not a shared cookie.
 */
export const CROSS_DOMAINS: string[] = ["itegro-gmbh.de", "app.code-review.com"];
