// SPDX-License-Identifier: LicenseRef-Proprietary

// A catalog model as the admin portal sees it (#549, #554): the catalog row, the admin's decisions and the price with its
// status and sources. For the instance admin only: it names the provider and the model and shows prices, none of which
// a member of a workspace ever sees (Epic #489, principle 2 of #420). The strings of models.dev inside it are untrusted
// text; the page escapes them.
import "server-only";
import type { ModelEnablement } from "../db/repositories/model-enablements-repository.ts";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import type { UrlState } from "../models-dev/upstream-url.ts";
import {
  managedAvailability,
  type ManagedUnavailableReason,
} from "./availability.ts";
import {
  isUnreadable,
  type LatestConfirmation,
  type PriceConfirmation,
} from "./confirmation.ts";
import {
  effectivePrice,
  type PriceSources,
  type PriceStatus,
} from "./effective-price.ts";
import type { ModelOverride } from "./overrides.ts";
import { priceBookToJson, type PriceBookJson } from "./price-book.ts";

export type PriceConfirmationView = {
  id: number;
  source: PriceConfirmation["source"];
  /** The price the admin confirmed. */
  book: PriceBookJson;
  /** The price models.dev and the override file stated then; null when they stated none. */
  reference: PriceBookJson | null;
  reason: string | null;
  confirmedBy: string | null;
  confirmedAt: string;
};

/** Something about a model's price that an admin should know before they decide. */
export const PRICE_WARNINGS = [
  /** The latest confirmation cannot be read back: the model counts as unconfirmed until it is confirmed again. */
  "confirmation_unreadable",
] as const;
export type PriceWarning = (typeof PRICE_WARNINGS)[number];

export type CatalogModelView = {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  limit: StoredModel["limit"];
  reasoning: boolean;
  /** models.dev's own status; `deprecated` and `alpha` are shown as a warning. */
  upstreamStatus: StoredModel["status"];
  /** False once models.dev no longer lists the model; the last known row stays and a confirmed model stays selectable. */
  listed: boolean;
  unlistedAt: string | null;
  firstSeenAt: string;
  /** In the catalog since after the first fetch, and nobody has enabled or disabled it. */
  isNew: boolean;
  providerUrl: UrlState;
  /** True or false once the admin decided; null while they have not. */
  enabled: boolean | null;
  enablement: { changedBy: string | null; changedAt: string } | null;
  price: {
    status: PriceStatus;
    warnings: PriceWarning[];
    /** What the managed key prices from when `confirmed`; otherwise the old price of a stale one, or the proposal: a price to look at, never one to run on (`managed` says whether it may run). */
    book: PriceBookJson | null;
    sources: PriceSources | null;
    /** The price today, from models.dev and the override file; `hash` is what a confirmation must echo. */
    reference: {
      book: PriceBookJson | null;
      hash: string;
      sources: PriceSources | null;
    };
    confirmation: PriceConfirmationView | null;
  };
  override: {
    reason: string;
    blocked: boolean;
    retiresNotBefore: string | null;
  } | null;
  managed:
    | { selectable: true; reason: null }
    | { selectable: false; reason: ManagedUnavailableReason };
};

export type ModelViewInput = {
  provider: StoredProvider;
  model: StoredModel;
  enablement: ModelEnablement | undefined;
  confirmation: LatestConfirmation | undefined;
  override: ModelOverride | undefined;
  /** When the first model was seen: models first seen after it are new. */
  firstFetchAt: string | null;
  now: Date;
};

const json = (book: Parameters<typeof priceBookToJson>[0] | null) =>
  book === null ? null : priceBookToJson(book);

export function toModelView(input: ModelViewInput): CatalogModelView {
  const { provider, model, enablement, override } = input;
  // A confirmation that cannot be read is no confirmation for the price, and a warning for the admin.
  const confirmation = isUnreadable(input.confirmation)
    ? undefined
    : input.confirmation;
  const price = effectivePrice({
    cost: model.cost,
    reasoning: model.reasoning,
    override,
    confirmation: confirmation ?? null,
  });
  const available = managedAvailability({
    provider,
    model,
    enabled: enablement?.enabled === true,
    override,
    price,
    now: input.now,
  });
  const listed = model.unlistedAt === null;
  return {
    providerId: model.providerId,
    providerName: provider.name,
    modelId: model.id,
    name: model.name,
    limit: model.limit,
    reasoning: model.reasoning,
    upstreamStatus: model.status,
    listed,
    unlistedAt: model.unlistedAt,
    firstSeenAt: model.firstSeenAt,
    isNew:
      enablement === undefined &&
      listed &&
      input.firstFetchAt !== null &&
      model.firstSeenAt > input.firstFetchAt,
    providerUrl: provider.url.state,
    enabled: enablement === undefined ? null : enablement.enabled,
    enablement:
      enablement === undefined
        ? null
        : { changedBy: enablement.changedBy, changedAt: enablement.changedAt },
    price: {
      status: price.status,
      warnings: isUnreadable(input.confirmation)
        ? ["confirmation_unreadable"]
        : [],
      book: json(price.display),
      sources: price.sources,
      reference: {
        book: json(price.reference.book),
        hash: price.reference.hash,
        sources: price.reference.sources,
      },
      confirmation:
        confirmation === undefined
          ? null
          : {
              id: confirmation.id,
              source: confirmation.source,
              book: priceBookToJson(confirmation.book),
              reference: json(confirmation.reference),
              reason: confirmation.reason,
              confirmedBy: confirmation.confirmedBy,
              confirmedAt: confirmation.confirmedAt,
            },
    },
    override:
      override === undefined
        ? null
        : {
            reason: override.reason,
            blocked: override.blocked,
            retiresNotBefore: override.retiresNotBefore,
          },
    managed: available.selectable
      ? { selectable: true, reason: null }
      : { selectable: false, reason: available.reason },
  };
}
