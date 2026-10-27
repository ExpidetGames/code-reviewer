// SPDX-License-Identifier: LicenseRef-Proprietary

// What the tier migration (`../20261018170000_migrate_model_tiers_to_catalog.ts`) knew about the application on
// 2026-10-18, as constants and two small functions of its own (#715, cut 9). A migration is frozen: it must give the
// same result when it runs in a year, whatever the LLM providers and the catalog have become by then, so it does not
// import them. Only the files of `db/migrations/` import this module (`import-cycles/graph.ts` checks it), and nobody
// edits it: a rule that changes later is a new migration.

/** The default LLM provider of that day (OpenRouter): the provider of every entry the migration makes. */
export const TIER_MIGRATION_PROVIDER = "openrouter";

/** The model id rule of that provider: 1 to 200 characters, starting with a letter or a digit. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;

export function isTierMigrationModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model);
}

/** What two catalog entry names are compared by: the same for names that differ only in case or in compatibility forms. */
export function nameKeyOf(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}
