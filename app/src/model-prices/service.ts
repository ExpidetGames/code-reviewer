// SPDX-License-Identifier: Apache-2.0

// The admin's decisions about catalog models (#549): whether a model is enabled for the managed key, and whether its price
// is confirmed. A model is selectable on the managed key only when both hold (`availability.ts`), and a price that models.dev
// or the override file changed after the confirmation counts as unconfirmed until the admin confirms it again.
//
// A confirmation is made against the price the admin saw: the request carries the hash of that reference price, and a price
// that has changed since is refused (`price_changed`), so an admin never confirms a price they did not look at. It runs in
// one transaction that first takes the provider's row `FOR UPDATE` on Postgres, the lock the daily fetch holds while it
// writes (`listProviders({ forUpdate: true })`, #548), so a confirmation waits for a fetch that is writing and then reads what
// the fetch wrote; on SQLite every transaction begins `begin immediate`. The fetch never writes the confirmation tables,
// so it cannot overwrite a confirmation; a price it moves afterwards makes the confirmation stale.
//
// Every write that succeeds writes one audit line after it is stored: the person, the model, the old and the new price, a
// correction's reason (as a JSON string, so a line break cannot split the line). Never a key. Nothing here is reachable by a
// member of a workspace; the routes are the admin portal's (admin-http.ts).
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  createModelEnablementsRepository,
  type ModelEnablement,
} from "../db/repositories/model-enablements-repository.ts";
import { createModelPriceConfirmationsRepository } from "../db/repositories/model-price-confirmations-repository.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { databaseDriver } from "../db/driver.ts";
import type { Database } from "../db/schema.ts";
import type { FetchState } from "../models-dev/catalog.ts";
import {
  managedAvailability,
  managedAvailabilityToJson,
  type ManagedAvailabilityJson,
} from "./availability.ts";
import { isUnreadable, type PriceConfirmation } from "./confirmation.ts";
import { toModelView, type CatalogModelView } from "./admin-view.ts";
import { effectivePrice, type PriceStatus } from "./effective-price.ts";
import type { ModelPriceErrorCode } from "./errors.ts";
import { modelOverride, type ModelOverride } from "./overrides.ts";
import {
  parsePriceBookJson,
  priceBookToJson,
  type PriceBook,
  type PriceBookJson,
} from "./price-book.ts";

export type ModelPriceRefusal = {
  ok: false;
  code: ModelPriceErrorCode;
  /** The field of the request the refusal belongs to, when it belongs to one. */
  field?: string;
};
export type ModelChange =
  { ok: true; model: CatalogModelView } | ModelPriceRefusal;

export const ENABLED_FILTERS = ["yes", "no", "undecided"] as const;
export type ListQuery = {
  provider?: string;
  /** Matches the model id or name, whatever the case. */
  search?: string;
  priceStatus?: PriceStatus;
  enabled?: (typeof ENABLED_FILTERS)[number];
  onlyNew?: boolean;
  limit?: number;
  offset?: number;
};
export type ModelList = {
  models: CatalogModelView[];
  /** How many models match, before the page. */
  total: number;
  /** How many models in the whole catalog are new: the badge of the portal. */
  newCount: number;
  fetch: FetchState | null;
};

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
export const MAX_REASON_LENGTH = 500;
/** How long a confirmation waits for the daily fetch's lock on Postgres before it gives up with `fetch_in_progress`. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** Postgres' error code for a lock that could not be taken within `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

export type ModelPriceService = {
  list(query: ListQuery): Promise<ModelList>;
  get(
    providerId: string,
    modelId: string,
  ): Promise<{ ok: true; model: CatalogModelView } | ModelPriceRefusal>;
  /** `{ providerId, modelId, enabled }`. */
  setEnabled(actorId: string, input: unknown): Promise<ModelChange>;
  /**
   * `{ providerId, modelId }`: takes the admin's decision back, enabled or disabled, so that the model has none again (it is
   * "new" once more when it was first seen after the first fetch, and is not selectable). The price confirmations stay.
   */
  resetDecision(actorId: string, input: unknown): Promise<ModelChange>;
  /** `{ providerId, modelId, referenceHash }`: confirms the reference price as the admin saw it. */
  confirmPrice(actorId: string, input: unknown): Promise<ModelChange>;
  /** `{ providerId, modelId, referenceHash, price, reason }`: states the price, against the reference the admin saw. */
  correctPrice(actorId: string, input: unknown): Promise<ModelChange>;
  /**
   * Whether the managed key may use the model now, and at which price (for the claim of #553), in a form that is JSON as it
   * is: amounts are decimal strings of whole micro-USD per million tokens (`bigint` is only used inside), with the id of the
   * confirmation and the version of its hash. **It never throws:** a database that cannot be read is a refusal
   * (`{ selectable: false, reason: "check_failed", code: "catalog_model_unavailable" }`) and one log line without detail, because
   * the caller must treat anything but `selectable: true` as "the managed key is not used", and an exception is easy to
   * handle as something else. A refusal carries a stable `code` (`catalog_price_unconfirmed` for a price that is not
   * confirmed or no longer is, `catalog_model_unavailable` otherwise).
   */
  availability(
    providerId: string,
    modelId: string,
  ): Promise<ManagedAvailabilityJson>;
  /**
   * The price a run on the workspace's **own** key is priced from (#553), in the JSON form of the book: nobody but the user
   * pays, so no confirmation is needed. It is the confirmed book when the price is confirmed, else the price the catalog
   * states today (models.dev with the override file), else `null` for a model nobody priced or one the catalog does not
   * have. Never throws: a database that cannot be read is `null` too, and an unpriced run is bound by its token cap, so a
   * failed read costs a run its price and not its safety.
   */
  catalogPrice(
    providerId: string,
    modelId: string,
  ): Promise<PriceBookJson | null>;
};

export type ModelPriceServiceDependencies = {
  db: Kysely<Database>;
  now?: () => Date;
  /** How long a confirmation waits for the fetch's lock on Postgres; tests shorten it. */
  lockTimeoutMs?: number;
  /** Where the audit line goes (the server's log in production, a list in tests). */
  log?: { info(line: string): void; error?(line: string): void };
  /** The override file; tests bring their own. */
  overrideOf?: (
    providerId: string,
    modelId: string,
  ) => ModelOverride | undefined;
};

const refuse = (
  code: ModelPriceErrorCode,
  field?: string,
): ModelPriceRefusal =>
  field === undefined ? { ok: false, code } : { ok: false, code, field };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of every key in `keys`, and nothing else in the object; undefined when it is not exactly that. */
function exactTexts<K extends string>(
  input: unknown,
  keys: readonly K[],
): Record<K, string> | undefined {
  if (!isRecord(input)) return undefined;
  const given = Object.keys(input);
  if (given.length !== keys.length) return undefined;
  const result = {} as Record<K, string>;
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string" || value === "") return undefined;
    result[key] = value;
  }
  return result;
}

function checkReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reason = value.trim();
  if (reason === "" || Array.from(reason).length > MAX_REASON_LENGTH)
    return undefined;
  return /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u.test(reason) ? reason : undefined;
}

type WrittenPrice = {
  ok: true;
  written: PriceConfirmation | null;
  before: PriceConfirmation | undefined;
};

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === LOCK_NOT_AVAILABLE
  );
}

const priceText = (book: PriceBook | null) =>
  book === null ? "none" : JSON.stringify(priceBookToJson(book));

export function createModelPriceService(
  deps: ModelPriceServiceDependencies,
): ModelPriceService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { info: (line: string) => console.info(line) };
  const logError =
    deps.log === undefined
      ? (line: string) => console.error(line)
      : (deps.log.error ?? ((line: string) => deps.log?.info(line)));
  const overrideOf = deps.overrideOf ?? modelOverride;
  const models = createModelsDevRepository(db);
  const enablements = createModelEnablementsRepository(db);
  const confirmations = createModelPriceConfirmationsRepository(db);
  const lockTimeoutMs = Math.max(
    1,
    Math.floor(deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS),
  );

  async function viewOf(
    executor: Kysely<Database>,
    providerId: string,
    modelId: string,
  ): Promise<CatalogModelView | undefined> {
    const catalog = createModelsDevRepository(executor);
    const [provider, model, enablement, confirmation, firstFetchAt] =
      await Promise.all([
        catalog.getProvider(providerId),
        catalog.getModel(providerId, modelId),
        createModelEnablementsRepository(executor).get(providerId, modelId),
        createModelPriceConfirmationsRepository(executor).latest(
          providerId,
          modelId,
        ),
        catalog.earliestModelSeenAt(),
      ]);
    if (provider === undefined || model === undefined) return undefined;
    return toModelView({
      provider,
      model,
      enablement,
      confirmation,
      override: overrideOf(providerId, modelId),
      firstFetchAt,
      now: now(),
    });
  }

  async function changed(
    providerId: string,
    modelId: string,
  ): Promise<ModelChange> {
    const model = await viewOf(db, providerId, modelId);
    return model === undefined ? refuse("model_unknown") : { ok: true, model };
  }

  /**
   * The checks and the write of a price confirmation, in one transaction behind the provider's lock. `price` is the book
   * to confirm: undefined confirms the reference as shown.
   */
  async function writePrice(
    actorId: string,
    ids: { providerId: string; modelId: string },
    referenceHash: string,
    statement: { price: PriceBook; reason: string } | undefined,
  ): Promise<WrittenPrice | ModelPriceRefusal> {
    return db
      .transaction()
      .execute(async (trx): Promise<WrittenPrice | ModelPriceRefusal> => {
        const catalog = createModelsDevRepository(trx);
        // On Postgres the wait for the fetch's lock is bounded; the number is an integer made here, never text of a request.
        if (databaseDriver(trx) === "postgres")
          await sql
            .raw(`set local lock_timeout = ${String(lockTimeoutMs)}`)
            .execute(trx);
        // The lock the fetch holds while it writes: wait for a fetch, then read what it wrote.
        const provider = await catalog.getProvider(ids.providerId, {
          forUpdate: true,
        });
        const model = await catalog.getModel(ids.providerId, ids.modelId);
        if (provider === undefined || model === undefined)
          return refuse("model_unknown");
        const history = createModelPriceConfirmationsRepository(trx);
        const latest = await history.latest(ids.providerId, ids.modelId);
        // A row that cannot be read is replaced by the new confirmation, never compared with it.
        const before = isUnreadable(latest) ? undefined : latest;
        const today = effectivePrice({
          cost: model.cost,
          reasoning: model.reasoning,
          override: overrideOf(ids.providerId, ids.modelId),
          confirmation: null,
        }).reference;
        if (statement === undefined && today.book === null)
          return refuse("price_missing");
        if (today.hash !== referenceHash) return refuse("price_changed");
        const book = statement?.price ?? (today.book as PriceBook);
        // Confirming again what is confirmed already changes nothing, so the history holds decisions only.
        if (
          statement === undefined &&
          before?.referenceHash === today.hash &&
          priceText(before.book) === priceText(book)
        )
          return { ok: true, written: null, before };
        const written = await history.append(
          {
            providerId: ids.providerId,
            modelId: ids.modelId,
            source: statement === undefined ? "catalog" : "admin",
            book,
            reference: today.book,
            referenceHash: today.hash,
            reason: statement?.reason ?? null,
            confirmedBy: actorId,
          },
          now(),
        );
        return { ok: true, written, before };
      })
      .catch((error: unknown): ModelPriceRefusal => {
        // The fetch kept its lock for longer than we wait: nothing was written, and the admin tries again.
        if (isLockTimeout(error)) return refuse("fetch_in_progress");
        throw error;
      });
  }

  return {
    async list(query) {
      const [providers, rows, decisions, latest, firstFetchAt, fetch] =
        await Promise.all([
          models.listProviders(),
          models.listModels(),
          enablements.list(),
          confirmations.listLatest(),
          models.earliestModelSeenAt(),
          models.fetchState(),
        ]);
      const providerById = new Map(providers.map((p) => [p.id, p]));
      const key = (providerId: string, modelId: string) =>
        `${providerId}\u0000${modelId}`;
      const decisionOf = new Map(
        decisions.map((d: ModelEnablement) => [
          key(d.providerId, d.modelId),
          d,
        ]),
      );
      const confirmationOf = new Map(
        latest.map((c) => [key(c.providerId, c.modelId), c]),
      );
      const time = now();
      const views: CatalogModelView[] = [];
      for (const model of rows) {
        const provider = providerById.get(model.providerId);
        if (provider === undefined) continue;
        views.push(
          toModelView({
            provider,
            model,
            enablement: decisionOf.get(key(model.providerId, model.id)),
            confirmation: confirmationOf.get(key(model.providerId, model.id)),
            override: overrideOf(model.providerId, model.id),
            firstFetchAt,
            now: time,
          }),
        );
      }
      const search = query.search?.trim().toLowerCase() ?? "";
      const matching = views
        .filter((view) => {
          if (
            query.provider !== undefined &&
            view.providerId !== query.provider
          )
            return false;
          if (
            search !== "" &&
            !view.modelId.toLowerCase().includes(search) &&
            !view.name.toLowerCase().includes(search)
          )
            return false;
          if (
            query.priceStatus !== undefined &&
            view.price.status !== query.priceStatus
          )
            return false;
          if (query.enabled === "yes" && view.enabled !== true) return false;
          if (query.enabled === "no" && view.enabled !== false) return false;
          if (query.enabled === "undecided" && view.enabled !== null)
            return false;
          return query.onlyNew !== true || view.isNew;
        })
        // The newest first, which is what "new" is read by; then by name so that a page does not move between requests.
        .sort(
          (a, b) =>
            b.firstSeenAt.localeCompare(a.firstSeenAt) ||
            a.providerId.localeCompare(b.providerId) ||
            a.modelId.localeCompare(b.modelId),
        );
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE,
      );
      const offset = Math.max(query.offset ?? 0, 0);
      return {
        models: matching.slice(offset, offset + limit),
        total: matching.length,
        newCount: views.filter((view) => view.isNew).length,
        fetch: fetch ?? null,
      };
    },

    async get(providerId, modelId) {
      const model = await viewOf(db, providerId, modelId);
      return model === undefined
        ? refuse("model_unknown")
        : { ok: true, model };
    },

    async setEnabled(actorId, input) {
      const given = isRecord(input) ? input : {};
      const ids = exactTexts(
        { providerId: given.providerId, modelId: given.modelId },
        ["providerId", "modelId"],
      );
      if (
        ids === undefined ||
        Object.keys(given).length !== 3 ||
        typeof given.enabled !== "boolean"
      )
        return refuse("request_invalid");
      const enabled = given.enabled;
      const exists = await models.getModel(ids.providerId, ids.modelId);
      if (exists === undefined) return refuse("model_unknown");
      if (enabled && overrideOf(ids.providerId, ids.modelId)?.blocked === true)
        return refuse("model_blocked");
      await enablements.set({ ...ids, enabled, changedBy: actorId }, now());
      log.info(
        `model prices: ${enabled ? "MODEL_ENABLED" : "MODEL_DISABLED"} by=${actorId} model=${ids.providerId}/${ids.modelId}`,
      );
      return changed(ids.providerId, ids.modelId);
    },

    async resetDecision(actorId, input) {
      const ids = exactTexts(input, ["providerId", "modelId"]);
      if (ids === undefined) return refuse("request_invalid");
      const exists = await models.getModel(ids.providerId, ids.modelId);
      if (exists === undefined) return refuse("model_unknown");
      // Nothing to take back writes nothing and logs nothing.
      if (await enablements.clear(ids.providerId, ids.modelId))
        log.info(
          `model prices: MODEL_DECISION_RESET by=${actorId} model=${ids.providerId}/${ids.modelId}`,
        );
      return changed(ids.providerId, ids.modelId);
    },

    async confirmPrice(actorId, input) {
      const given = exactTexts(input, [
        "providerId",
        "modelId",
        "referenceHash",
      ]);
      if (given === undefined) return refuse("request_invalid");
      const { referenceHash, ...ids } = given;
      const result = await writePrice(actorId, ids, referenceHash, undefined);
      if (!result.ok) return result;
      if (result.written !== null)
        log.info(
          `model prices: PRICE_CONFIRMED by=${actorId} model=${ids.providerId}/${ids.modelId} source=catalog old=${priceText(result.before?.book ?? null)} new=${priceText(result.written.book)}`,
        );
      return changed(ids.providerId, ids.modelId);
    },

    async correctPrice(actorId, input) {
      if (!isRecord(input) || Object.keys(input).length !== 5)
        return refuse("request_invalid");
      const ids = exactTexts(
        {
          providerId: input.providerId,
          modelId: input.modelId,
          referenceHash: input.referenceHash,
        },
        ["providerId", "modelId", "referenceHash"],
      );
      if (ids === undefined || !("price" in input) || !("reason" in input))
        return refuse("request_invalid");
      const price = parsePriceBookJson(input.price);
      if (!price.ok) return refuse("price_invalid", "price");
      const reason = checkReason(input.reason);
      if (reason === undefined) return refuse("reason_invalid", "reason");
      const { referenceHash, ...modelIds } = ids;
      const result = await writePrice(actorId, modelIds, referenceHash, {
        price: price.book,
        reason,
      });
      if (!result.ok) return result;
      if (result.written !== null)
        log.info(
          `model prices: PRICE_CORRECTED by=${actorId} model=${modelIds.providerId}/${modelIds.modelId} old=${priceText(result.before?.book ?? null)} new=${priceText(result.written.book)} reason=${JSON.stringify(reason)}`,
        );
      return changed(modelIds.providerId, modelIds.modelId);
    },

    async catalogPrice(providerId, modelId) {
      try {
        const [model, confirmation] = await Promise.all([
          models.getModel(providerId, modelId),
          confirmations.latest(providerId, modelId),
        ]);
        if (model === undefined) return null;
        const price = effectivePrice({
          cost: model.cost,
          reasoning: model.reasoning,
          override: overrideOf(providerId, modelId),
          confirmation: isUnreadable(confirmation)
            ? null
            : (confirmation ?? null),
        });
        const book =
          price.status === "confirmed" ? price.book : price.reference.book;
        return book === null ? null : priceBookToJson(book);
      } catch {
        return null;
      }
    },

    async availability(providerId, modelId) {
      try {
        const [provider, model, enablement, confirmation] = await Promise.all([
          models.getProvider(providerId),
          models.getModel(providerId, modelId),
          enablements.get(providerId, modelId),
          confirmations.latest(providerId, modelId),
        ]);
        const override = overrideOf(providerId, modelId);
        return managedAvailabilityToJson(
          managedAvailability({
            provider,
            model,
            enabled: enablement?.enabled === true,
            override,
            price: effectivePrice({
              cost: model?.cost ?? null,
              reasoning: model?.reasoning ?? false,
              override,
              confirmation: isUnreadable(confirmation)
                ? null
                : (confirmation ?? null),
            }),
            now: now(),
          }),
        );
      } catch {
        // No error text: it could carry whatever the failing layer held (a model id, a price).
        logError(
          "model prices: AVAILABILITY_CHECK_FAILED: the managed key is refused for this model.",
        );
        return managedAvailabilityToJson({
          selectable: false,
          reason: "check_failed",
        });
      }
    },
  };
}
