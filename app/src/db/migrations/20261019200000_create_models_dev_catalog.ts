// SPDX-License-Identifier: Apache-2.0

// The catalog read from models.dev (#548, src/models-dev/README.md): the providers and models a job can use, fetched
// daily at run time, and the state of the last fetch. Instance level: it is configuration of the installation, not
// customer data, and no workspace owns a row. Three new, empty tables; no existing row is touched, so an app of the
// previous release (which never reads them) keeps working on the same database.
//
// Nothing is ever deleted: a provider or model that disappears upstream gets `unlisted_at` and keeps its last known row;
// one that returns clears it. `url_state` and its columns hold the trust on first use of the provider's address
// (src/models-dev/upstream-url.ts): `trusted` has a `trusted_url`, `url_changed` keeps it and waits for an admin to
// confirm `pending_url`, `rejected` never had a safe address. `upstream_status` is models.dev's own status (`deprecated`
// is shown as a warning). Prices and modalities are JSON text (decimal strings, USD per million tokens). Everything
// from models.dev is untrusted text, length-capped by the reader before it gets here.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("models_dev_providers")
      .addColumn("provider_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("url_state", "text", (column) => column.notNull())
      .addColumn("trusted_url", "text")
      .addColumn("pending_url", "text")
      .addColumn("url_problem", "text")
      .addColumn("url_changed_at", "text")
      .addColumn("first_seen_at", "text", (column) => column.notNull())
      .addColumn("unlisted_at", "text")
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "models_dev_providers_url_state_check",
        sql`url_state in ('trusted', 'url_changed', 'rejected')`,
      )
      .addCheckConstraint(
        "models_dev_providers_trusted_check",
        sql`url_state = 'rejected' or trusted_url is not null`,
      )
      .execute();

    await db.schema
      .createTable("models_dev_models")
      .addColumn("provider_id", "text", (column) =>
        column.notNull().references("models_dev_providers.provider_id"),
      )
      .addColumn("model_id", "text", (column) => column.notNull())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("family", "text")
      .addColumn("context_limit", "integer", (column) => column.notNull())
      .addColumn("output_limit", "integer", (column) => column.notNull())
      .addColumn("input_limit", "integer")
      .addColumn("reasoning", "integer", (column) => column.notNull())
      .addColumn("temperature", "integer", (column) => column.notNull())
      .addColumn("attachment", "integer", (column) => column.notNull())
      .addColumn("modalities", "text", (column) => column.notNull())
      .addColumn("upstream_status", "text")
      .addColumn("cost", "text")
      .addColumn("upstream_updated", "text")
      .addColumn("interleaved", "text")
      .addColumn("first_seen_at", "text", (column) => column.notNull())
      .addColumn("unlisted_at", "text")
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("models_dev_models_pk", [
        "provider_id",
        "model_id",
      ])
      .addCheckConstraint(
        "models_dev_models_flags_check",
        sql`reasoning in (0, 1) and temperature in (0, 1) and attachment in (0, 1)`,
      )
      .addCheckConstraint(
        "models_dev_models_limits_check",
        sql`context_limit > 0 and output_limit > 0`,
      )
      .execute();

    // One row, `models.dev`: when the last fetch ran, how it ended (`ok` or `failed`) and, for a failure, its stable code.
    await db.schema
      .createTable("models_dev_fetch_state")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("last_attempt_at", "text")
      .addColumn("last_success_at", "text")
      .addColumn("last_status", "text", (column) => column.notNull())
      .addColumn("last_error", "text")
      .addColumn("last_summary", "text")
      .addCheckConstraint(
        "models_dev_fetch_state_id_check",
        sql`id = 'models.dev'`,
      )
      .addCheckConstraint(
        "models_dev_fetch_state_status_check",
        sql`last_status in ('ok', 'failed')`,
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("models_dev_models").execute();
    await db.schema.dropTable("models_dev_providers").execute();
    await db.schema.dropTable("models_dev_fetch_state").execute();
  },
};
