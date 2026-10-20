// SPDX-License-Identifier: Apache-2.0

// Access to the models.dev catalog tables (#548, src/models-dev/README.md): the providers and models a job can use, and
// the state of the last fetch. Instance level: this is configuration of the installation, not customer data, and no
// workspace owns a row. The repository only stores and reads; what a fetch writes, and whether it may, is decided in
// src/models-dev/ (the fetch guard, the trust on first use). It never deletes a row: a provider or model that goes away
// upstream is written again with `unlistedAt`.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import {
  decodeBoolean,
  encodeBoolean,
  encodeJson,
  formatTimestamp,
  tryDecodeJson,
} from "../codecs.ts";
import type {
  CatalogWrite,
  FetchState,
  FetchSummary,
  StoredModel,
  StoredProvider,
} from "../../models-dev/catalog.ts";
import {
  isModelsDevFetchErrorCode,
  ModelsDevDeadlineError,
  type ModelsDevFetchErrorCode,
} from "../../models-dev/errors.ts";
import {
  MODALITIES,
  MODELS_DEV_STATUSES,
  type Interleaved,
  type Modality,
  type ModelCost,
} from "../../models-dev/parse.ts";
import {
  URL_PROBLEMS,
  URL_STATES,
  type UrlProblem,
  type UrlState,
} from "../../models-dev/upstream-url.ts";
import { databaseDriver } from "../driver.ts";
import type {
  Database,
  ModelsDevModelsTable,
  ModelsDevProvidersTable,
} from "../schema.ts";

const STATE_ID = "models.dev";
/** Rows per statement: well below the parameter limit of either engine. */
const BATCH = 100;

export type ModelsDevRepository = {
  /**
   * Every provider, listed or not. `forUpdate` locks the rows until the transaction ends on Postgres (`FOR UPDATE`; no
   * effect outside a transaction), so that a write made by someone else in between, an admin's confirmation of a changed
   * address (#554), waits and is not written over by a plan made on the old rows. On SQLite every transaction begins with
   * `begin immediate` (src/db/dialect.ts), so a second writer waits for the whole transaction anyway and the option does
   * nothing. A confirmation is a guarded update of the one row (`... where provider_id = ? and pending_url = ?`), made in
   * its own transaction; it needs no other lock.
   */
  listProviders(options?: { forUpdate?: boolean }): Promise<StoredProvider[]>;
  /** Every model, listed or not. */
  listModels(): Promise<StoredModel[]>;
  /**
   * One provider. `forUpdate` locks the row until the transaction ends on Postgres, as for `listProviders`: a write to a
   * model of the provider that must not run beside a fetch (an admin's price confirmation, #549) takes this lock first, so
   * that it waits for a fetch that is writing and then reads what the fetch wrote. On SQLite every transaction begins
   * with `begin immediate`, so the option does nothing.
   */
  getProvider(
    id: string,
    options?: { forUpdate?: boolean },
  ): Promise<StoredProvider | undefined>;
  getModel(
    providerId: string,
    modelId: string,
  ): Promise<StoredModel | undefined>;
  /** When the first model was seen, i.e. the day of the first fetch; null while the catalog is empty. */
  earliestModelSeenAt(): Promise<string | null>;
  fetchState(): Promise<FetchState | undefined>;
  /**
   * Writes the given rows (insert, or replace all but `first_seen_at`) in one transaction and, when `success` is given,
   * records the fetch as ok in the same one. Deletes nothing.
   */
  apply(
    write: CatalogWrite,
    success?: { summary: FetchSummary; at: Date },
    options?: {
      /** Asked before every batch; when it says stop, the transaction is rolled back and `ModelsDevDeadlineError` thrown. */
      shouldStop?: () => boolean;
    },
  ): Promise<void>;
  /**
   * Records that an attempt begins, before anything is fetched: a run the platform stops (a serverless function at its
   * limit) leaves no other trace, and without this the next sweep would try again at once. A new state row reads as a
   * failure that was interrupted; an existing one keeps how its last run ended and only moves `last_attempt_at`.
   */
  recordAttempt(at: Date): Promise<void>;
  /** Records a fetch that changed nothing, with its stable code; the last success and the catalog stay. */
  recordFailure(code: ModelsDevFetchErrorCode, at: Date): Promise<void>;
  recordSuccess(summary: FetchSummary, at: Date): Promise<void>;
};

type ProviderRow = Selectable<ModelsDevProvidersTable>;
type ModelRow = Selectable<ModelsDevModelsTable>;

function oneOf<T extends string>(
  list: readonly T[],
  value: string | null,
): T | null {
  return list.find((candidate) => candidate === value) ?? null;
}

function providerOf(row: ProviderRow): StoredProvider {
  const state: UrlState = oneOf(URL_STATES, row.url_state) ?? "rejected";
  const problem: UrlProblem | null = oneOf(URL_PROBLEMS, row.url_problem);
  return {
    id: row.provider_id,
    name: row.name,
    url: {
      state,
      trustedUrl: row.trusted_url,
      pendingUrl: row.pending_url,
      problem,
    },
    urlChangedAt: row.url_changed_at,
    firstSeenAt: row.first_seen_at,
    unlistedAt: row.unlisted_at,
    updatedAt: row.updated_at,
  };
}

function providerRow(provider: StoredProvider): ProviderRow {
  return {
    provider_id: provider.id,
    name: provider.name,
    url_state: provider.url.state,
    trusted_url: provider.url.trustedUrl,
    pending_url: provider.url.pendingUrl,
    url_problem: provider.url.problem,
    url_changed_at: provider.urlChangedAt,
    first_seen_at: provider.firstSeenAt,
    unlisted_at: provider.unlistedAt,
    updated_at: provider.updatedAt,
  };
}

function json<T>(text: string | null): T | null {
  if (text === null) return null;
  const decoded = tryDecodeJson<T>(text);
  return decoded.ok ? decoded.value : null;
}

function modalitiesOf(text: string): StoredModel["modalities"] {
  const raw = json<{ input?: unknown[]; output?: unknown[] }>(text);
  const known = (values: unknown[] | undefined): Modality[] =>
    MODALITIES.filter((modality) => values?.includes(modality) === true);
  return { input: known(raw?.input), output: known(raw?.output) };
}

function modelOf(row: ModelRow): StoredModel {
  return {
    providerId: row.provider_id,
    id: row.model_id,
    name: row.name,
    family: row.family,
    limit: {
      context: row.context_limit,
      output: row.output_limit,
      ...(row.input_limit === null ? {} : { input: row.input_limit }),
    },
    reasoning: decodeBoolean(row.reasoning),
    temperature: decodeBoolean(row.temperature),
    attachment: decodeBoolean(row.attachment),
    modalities: modalitiesOf(row.modalities),
    status: oneOf(MODELS_DEV_STATUSES, row.upstream_status),
    cost: json<ModelCost>(row.cost),
    lastUpdated: row.upstream_updated,
    interleaved: json<Interleaved>(row.interleaved),
    firstSeenAt: row.first_seen_at,
    unlistedAt: row.unlisted_at,
    updatedAt: row.updated_at,
  };
}

function modelRow(model: StoredModel): ModelRow {
  return {
    provider_id: model.providerId,
    model_id: model.id,
    name: model.name,
    family: model.family,
    context_limit: model.limit.context,
    output_limit: model.limit.output,
    input_limit: model.limit.input ?? null,
    reasoning: encodeBoolean(model.reasoning),
    temperature: encodeBoolean(model.temperature),
    attachment: encodeBoolean(model.attachment),
    modalities: encodeJson(model.modalities),
    upstream_status: model.status,
    cost: model.cost === null ? null : encodeJson(model.cost),
    upstream_updated: model.lastUpdated,
    interleaved:
      model.interleaved === null ? null : encodeJson(model.interleaved),
    first_seen_at: model.firstSeenAt,
    unlisted_at: model.unlistedAt,
    updated_at: model.updatedAt,
  };
}

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH)
    result.push(items.slice(index, index + BATCH));
  return result;
}

async function writeState(
  db: Kysely<Database>,
  values: {
    last_attempt_at: string;
    last_success_at?: string;
    last_status: "ok" | "failed";
    last_error: string | null;
    last_summary?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("models_dev_fetch_state")
    .values({
      id: STATE_ID,
      last_success_at: null,
      last_summary: null,
      ...values,
    })
    .onConflict((conflict) => conflict.column("id").doUpdateSet(values))
    .execute();
}

export function createModelsDevRepository(
  db: Kysely<Database>,
): ModelsDevRepository {
  async function success(
    trx: Kysely<Database>,
    summary: FetchSummary,
    at: Date,
  ): Promise<void> {
    const stamp = formatTimestamp(at);
    await writeState(trx, {
      last_attempt_at: stamp,
      last_success_at: stamp,
      last_status: "ok",
      last_error: null,
      last_summary: encodeJson(summary),
    });
  }

  return {
    async listProviders(options) {
      let query = db
        .selectFrom("models_dev_providers")
        .selectAll()
        .orderBy("provider_id");
      if (options?.forUpdate === true && databaseDriver(db) === "postgres")
        query = query.forUpdate();
      const rows = await query.execute();
      return rows.map(providerOf);
    },

    async listModels() {
      const rows = await db
        .selectFrom("models_dev_models")
        .selectAll()
        .orderBy("provider_id")
        .orderBy("model_id")
        .execute();
      return rows.map(modelOf);
    },

    async getProvider(id, options) {
      let query = db
        .selectFrom("models_dev_providers")
        .selectAll()
        .where("provider_id", "=", id);
      if (options?.forUpdate === true && databaseDriver(db) === "postgres")
        query = query.forUpdate();
      const row = await query.executeTakeFirst();
      return row === undefined ? undefined : providerOf(row);
    },

    async getModel(providerId, modelId) {
      const row = await db
        .selectFrom("models_dev_models")
        .selectAll()
        .where("provider_id", "=", providerId)
        .where("model_id", "=", modelId)
        .executeTakeFirst();
      return row === undefined ? undefined : modelOf(row);
    },

    async earliestModelSeenAt() {
      const row = await db
        .selectFrom("models_dev_models")
        .select((builder) => builder.fn.min("first_seen_at").as("first"))
        .executeTakeFirst();
      return row?.first ?? null;
    },

    async fetchState() {
      const row = await db
        .selectFrom("models_dev_fetch_state")
        .selectAll()
        .where("id", "=", STATE_ID)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        lastStatus: row.last_status === "ok" ? "ok" : "failed",
        lastError:
          row.last_error !== null && isModelsDevFetchErrorCode(row.last_error)
            ? row.last_error
            : null,
        lastSummary: json<FetchSummary>(row.last_summary),
      };
    },

    async apply(write, done, options) {
      const run = async (trx: Kysely<Database>) => {
        const stopIfAsked = () => {
          if (options?.shouldStop?.() === true)
            throw new ModelsDevDeadlineError();
        };
        // Providers first: a model refers to its provider.
        for (const batch of chunks(write.providers.map(providerRow))) {
          stopIfAsked();
          await trx
            .insertInto("models_dev_providers")
            .values(batch)
            .onConflict((conflict) =>
              conflict.column("provider_id").doUpdateSet((eb) => ({
                name: eb.ref("excluded.name"),
                url_state: eb.ref("excluded.url_state"),
                trusted_url: eb.ref("excluded.trusted_url"),
                pending_url: eb.ref("excluded.pending_url"),
                url_problem: eb.ref("excluded.url_problem"),
                url_changed_at: eb.ref("excluded.url_changed_at"),
                unlisted_at: eb.ref("excluded.unlisted_at"),
                updated_at: eb.ref("excluded.updated_at"),
              })),
            )
            .execute();
        }
        for (const batch of chunks(write.models.map(modelRow))) {
          stopIfAsked();
          await trx
            .insertInto("models_dev_models")
            .values(batch)
            .onConflict((conflict) =>
              conflict
                .columns(["provider_id", "model_id"])
                .doUpdateSet((eb) => ({
                  name: eb.ref("excluded.name"),
                  family: eb.ref("excluded.family"),
                  context_limit: eb.ref("excluded.context_limit"),
                  output_limit: eb.ref("excluded.output_limit"),
                  input_limit: eb.ref("excluded.input_limit"),
                  reasoning: eb.ref("excluded.reasoning"),
                  temperature: eb.ref("excluded.temperature"),
                  attachment: eb.ref("excluded.attachment"),
                  modalities: eb.ref("excluded.modalities"),
                  upstream_status: eb.ref("excluded.upstream_status"),
                  cost: eb.ref("excluded.cost"),
                  upstream_updated: eb.ref("excluded.upstream_updated"),
                  interleaved: eb.ref("excluded.interleaved"),
                  unlisted_at: eb.ref("excluded.unlisted_at"),
                  updated_at: eb.ref("excluded.updated_at"),
                })),
            )
            .execute();
        }
        stopIfAsked();
        if (done !== undefined) await success(trx, done.summary, done.at);
      };
      if (db.isTransaction) await run(db);
      else await db.transaction().execute(run);
    },

    async recordAttempt(at) {
      const stamp = formatTimestamp(at);
      await db
        .insertInto("models_dev_fetch_state")
        .values({
          id: STATE_ID,
          last_attempt_at: stamp,
          last_success_at: null,
          last_status: "failed",
          last_error: "models_dev_interrupted",
          last_summary: null,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({ last_attempt_at: stamp }),
        )
        .execute();
    },

    async recordFailure(code, at) {
      await writeState(db, {
        last_attempt_at: formatTimestamp(at),
        last_status: "failed",
        last_error: code,
      });
    },

    async recordSuccess(summary, at) {
      await success(db, summary, at);
    },
  };
}
