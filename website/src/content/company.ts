// SPDX-License-Identifier: LicenseRef-Proprietary

// Company data of the imprint. Plain data without imports of the site, because scripts/export-legal-markdown.mjs
// reads it with Node's type stripping.

export const COMPANY = {
  name: "Itegro GmbH",
  street: "Buchberger Straße 10c",
  postalCode: "82538",
  city: "Geretsried",
  country: "Germany",
  countryDe: "Deutschland",
  phone: "+49 8171 908924-2",
  email: "info@itegro-gmbh.de",
  vatId: "DE465402520",
  contentResponsible: "Luca Schackmann",
  web: "https://itegro-gmbh.de",
  managingDirectors: ["Luca Schackmann", "Lukas Laschinger", "Vincent Helmers"],
  registerCourt: "Amtsgericht München",
  registerNumber: "HRB 313463",
} as const;
