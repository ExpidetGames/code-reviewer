// SPDX-License-Identifier: Apache-2.0

// The admin's price confirmations of catalog models (#549, src/model-prices/README.md): an append-only history, and the
// latest row of a model is the one that counts. Instance level: configuration of the installation, not customer data. The
// database refuses an update and a delete of a row (a trigger), so a mistake is a new confirmation. A row is written only
// from a validated price book; a row whose price cannot be read back (edited outside the app) fails closed: it is an
// error, never "no confirmation" and never the row before it.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import {
  CONFIRMATION_SOURCES,
  type ConfirmationSource,
  type PriceConfirmation,
} from "../../model-prices/confirmation.ts";
import {
  parsePriceBookJson,
  priceBookToJson,
  type PriceBook,
} from "../../model-prices/price-book.ts";
import type { Database, ModelPriceConfirmationsTable } from "../schema.ts";

export type NewPriceConfirmation = {
  providerId: string;
  modelId: string;
  source: ConfirmationSource;
  book: PriceBook;
  reference: PriceBook | null;
  referenceHash: string;
  reason: string | null;
  confirmedBy: string | null;
};

export type ModelPriceConfirmationsRepository = {
  /** Appends a confirmation. Fails for a model the catalog does not have. */
  append(input: NewPriceConfirmation, at: Date): Promise<PriceConfirmation>;
  /** The confirmation that counts for a model, or undefined when nobody confirmed. */
  latest(
    providerId: string,
    modelId: string,
  ): Promise<PriceConfirmation | undefined>;
  /** The confirmation that counts for every model that has one. */
  listLatest(): Promise<PriceConfirmation[]>;
  /** Every confirmation of a model, the latest first. */
  history(providerId: string, modelId: string): Promise<PriceConfirmation[]>;
};

type Row = Selectable<ModelPriceConfirmationsTable>;

function readBook(text: string, id: number): PriceBook {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const parsed = parsePriceBookJson(json);
  if (!parsed.ok)
    throw new Error(
      `Price confirmation ${String(id)} holds a price that cannot be read.`,
    );
  return parsed.book;
}

function confirmationOf(row: Row): PriceConfirmation {
  const id = Number(row.id);
  const source = CONFIRMATION_SOURCES.find(
    (candidate) => candidate === row.source,
  );
  if (source === undefined)
    throw new Error(`Price confirmation ${String(id)} has an unknown source.`);
  return {
    id,
    providerId: row.provider_id,
    modelId: row.model_id,
    source,
    book: readBook(row.price, id),
    reference:
      row.reference_price === null ? null : readBook(row.reference_price, id),
    referenceHash: row.reference_hash,
    reason: row.reason,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
  };
}

export function createModelPriceConfirmationsRepository(
  db: Kysely<Database>,
): ModelPriceConfirmationsRepository {
  return {
    async append(input, at) {
      const row = await db
        .insertInto("model_price_confirmations")
        .values({
          provider_id: input.providerId,
          model_id: input.modelId,
          source: input.source,
          price: JSON.stringify(priceBookToJson(input.book)),
          reference_price:
            input.reference === null
              ? null
              : JSON.stringify(priceBookToJson(input.reference)),
          reference_hash: input.referenceHash,
          reason: input.reason,
          confirmed_by: input.confirmedBy,
          confirmed_at: formatTimestamp(at),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return confirmationOf(row);
    },

    async latest(providerId, modelId) {
      const row = await db
        .selectFrom("model_price_confirmations")
        .selectAll()
        .where("provider_id", "=", providerId)
        .where("model_id", "=", modelId)
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? undefined : confirmationOf(row);
    },

    async listLatest() {
      const rows = await db
        .selectFrom("model_price_confirmations")
        .selectAll()
        .where("id", "in", (query) =>
          query
            .selectFrom("model_price_confirmations")
            .select((builder) => builder.fn.max("id").as("id"))
            .groupBy(["provider_id", "model_id"]),
        )
        .orderBy("provider_id")
        .orderBy("model_id")
        .execute();
      return rows.map(confirmationOf);
    },

    async history(providerId, modelId) {
      const rows = await db
        .selectFrom("model_price_confirmations")
        .selectAll()
        .where("provider_id", "=", providerId)
        .where("model_id", "=", modelId)
        .orderBy("id", "desc")
        .execute();
      return rows.map(confirmationOf);
    },
  };
}
