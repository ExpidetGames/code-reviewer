// SPDX-License-Identifier: LicenseRef-Proprietary

// Shape of the long legal documents (privacy policy, terms of service). Plain data, so that
// scripts/export-legal-markdown.mjs can read the same texts and write them to legal/.

/** A paragraph (a string) or a bulleted list. */
export type LegalBlock = string | { list: string[] };
export type LegalSection = { id: string; heading: string; blocks: LegalBlock[] };
export type LegalDocument = {
  lang: "de" | "en";
  title: string;
  dateLabel: string;
  note?: string;
  sections: LegalSection[];
};
