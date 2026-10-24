// SPDX-License-Identifier: LicenseRef-Proprietary

// Decides what one fetch writes (#548), as a pure function of the parsed body, the stored rows and the verdicts on the
// providers' addresses. Nothing is deleted: a row that goes away upstream is written again with `unlistedAt` and keeps
// its last known data; one that returns clears it. Only rows that are new or changed are in the plan, so an unchanged
// day writes nothing. The guard says whether the plan is implausible: it would unlist a large share of what is listed,
// make the catalog grow by half, block the addresses of many providers at once, or the body held a provider of
// absurd size; the service then refuses to apply it (the old state stays) unless an admin accepts it.
import type { GuardFigures, GuardReason } from "./errors.ts";
import type {
  CatalogWrite,
  FetchSummary,
  StoredModel,
  StoredProvider,
} from "./catalog.ts";
import type { ParsedModelsDev, ReducedModel } from "./parse.ts";
import { normalizedAddress } from "../billing/public-url.ts";
import { supportedProvider } from "./opencode-providers.ts";
import { nextUrlState, type UrlCheck, type UrlRecord } from "./upstream-url.ts";

/** A fetch that would unlist more than this share of the listed models (or of the listed providers) is not applied. */
export const UNLISTED_SHARE_LIMIT = 0.1;
/**
 * A fetch that would unlist more than `UNLISTED_SHARE_LIMIT` of the models an admin enabled for the managed key (#549) is not
 * applied either, however few they are among all: they are the ones in use and paid for, so they come first. It takes at
 * least this many of them at once: one or two retired by their provider is the normal case and must reach the admin as
 * "no longer listed", not stop the day's fetch.
 */
export const ENABLED_UNLISTED_MIN_COUNT = 3;
/**
 * A fetch that would make the listed models grow by more than this share is not applied either: the catalog grows by a
 * few models a week, so half in one fetch is a poisoned or broken body, and it would be a way to fill the tables. The first
 * fetch into an empty database is exempt.
 */
export const GROWTH_LIMIT = 0.5;
/** A fetch that would block the address of more than this share of the providers at once is not applied ... */
export const URL_CHANGED_SHARE_LIMIT = 0.1;
/** ... when that is at least this many providers: one or two moving house is the normal case and must reach the admin. */
export const URL_CHANGED_MIN_COUNT = 3;

/**
 * A name that did not resolve when a provider was first seen is tried again at the next sweep, for this long after the
 * provider appeared: a transient failure of the resolver must not leave a provider rejected for a day, and a name that
 * never resolves must not make every sweep fetch the whole catalog.
 */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Guard = {
  tripped: boolean;
  /** Why, in a fixed order; empty when the fetch may be applied. */
  reasons: GuardReason[];
} & GuardFigures;

/** What the guard measured, without its verdict: for the admin who decides whether to accept a refused fetch. */
export function guardFigures(guard: Guard): GuardFigures {
  return {
    unlisted: guard.unlisted,
    listed: guard.listed,
    listedAfter: guard.listedAfter,
    providersUnlisted: guard.providersUnlisted,
    providersListed: guard.providersListed,
    enabledUnlisted: guard.enabledUnlisted,
    enabledListed: guard.enabledListed,
    newlyBlocked: guard.newlyBlocked,
    providers: guard.providers,
    oversizedProviders: guard.oversizedProviders,
  };
}

export type CatalogPlan = {
  write: CatalogWrite;
  summary: FetchSummary;
  guard: Guard;
};

type Input = {
  parsed: ParsedModelsDev;
  stored: {
    providers: readonly StoredProvider[];
    models: readonly StoredModel[];
  };
  /** The verdict on the address of each provider in `parsed`, by provider id. */
  urlChecks: ReadonlyMap<string, UrlCheck>;
  now: Date;
  /** The models an admin enabled (#549); the guard looks at them first. Left out, the guard is the catalog-wide one only. */
  enabled?: readonly { providerId: string; modelId: string }[];
};

/** Stable JSON: keys sorted at every level, so two equal values give one text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** What of a model comes from models.dev: everything but the bookkeeping of the row. */
function contentOf(model: ReducedModel): string {
  return canonical({
    name: model.name,
    family: model.family,
    limit: model.limit,
    reasoning: model.reasoning,
    temperature: model.temperature,
    attachment: model.attachment,
    modalities: model.modalities,
    status: model.status,
    cost: model.cost,
    lastUpdated: model.lastUpdated,
    interleaved: model.interleaved,
  });
}

/**
 * The address the committed provider file records as the default of a provider's SDK (`contracts/opencode-providers.v1.json`,
 * ten providers such as openai and google), in the one spelling addresses are compared in. It is trusted from the start:
 * the file is ours and is reviewed with the pin, so an address models.dev states instead is a change that waits for an
 * admin, not a first sight that is trusted.
 */
function seededUrl(providerId: string): UrlRecord | undefined {
  const url = supportedProvider(providerId)?.defaultBaseUrl;
  return url === undefined
    ? undefined
    : {
        state: "trusted",
        trustedUrl: normalizedAddress(url),
        pendingUrl: null,
        problem: null,
      };
}

const key = (providerId: string, id: string) => `${providerId}\u0000${id}`;

function planProviders(input: Input, stamp: string) {
  const { parsed, stored, urlChecks } = input;
  const before = new Map(
    stored.providers.map((provider) => [provider.id, provider]),
  );
  const writes: StoredProvider[] = [];
  let blocked = 0;
  let newlyBlocked = 0;
  let rejected = 0;
  let retry = 0;
  let added = 0;
  const seen = new Set<string>();
  for (const provider of parsed.providers) {
    seen.add(provider.id);
    const previous = before.get(provider.id);
    const check = urlChecks.get(provider.id) ?? {
      ok: false as const,
      problem: "missing" as const,
      seen: null,
    };
    // A stored trusted address is what stays trusted; otherwise the committed default of the provider, if there is one.
    const known =
      previous?.url.trustedUrl == null
        ? (seededUrl(provider.id) ?? previous?.url)
        : previous.url;
    const url = nextUrlState(known, check);
    if (url.state === "url_changed") blocked += 1;
    if (url.state === "url_changed" && previous?.url.state !== "url_changed")
      newlyBlocked += 1;
    if (url.state === "rejected") rejected += 1;
    const sameBlock =
      previous?.url.state === "url_changed" &&
      previous.url.pendingUrl === url.pendingUrl;
    const next: StoredProvider = {
      id: provider.id,
      name: provider.name,
      url,
      urlChangedAt:
        url.state !== "url_changed"
          ? null
          : sameBlock
            ? previous.urlChangedAt
            : stamp,
      firstSeenAt: previous?.firstSeenAt ?? stamp,
      unlistedAt: null,
      updatedAt: stamp,
    };
    if (previous === undefined) added += 1;
    if (
      url.state === "rejected" &&
      url.problem === "unresolvable" &&
      input.now.getTime() - Date.parse(next.firstSeenAt) < RETRY_WINDOW_MS
    )
      retry += 1;
    const same =
      previous !== undefined &&
      canonical({ ...previous, updatedAt: null }) ===
        canonical({ ...next, updatedAt: null });
    if (!same) writes.push(next);
  }
  let unlisted = 0;
  let listedBefore = 0;
  for (const previous of stored.providers) {
    if (previous.unlistedAt === null) listedBefore += 1;
    if (seen.has(previous.id) || previous.unlistedAt !== null) continue;
    unlisted += 1;
    writes.push({ ...previous, unlistedAt: stamp, updatedAt: stamp });
  }
  return {
    writes,
    blocked,
    newlyBlocked,
    rejected,
    retry,
    added,
    unlisted,
    listedBefore,
  };
}

function planModels(input: Input, stamp: string) {
  const { parsed, stored } = input;
  const before = new Map(
    stored.models.map((model) => [key(model.providerId, model.id), model]),
  );
  const writes: StoredModel[] = [];
  let added = 0;
  let changed = 0;
  let returned = 0;
  const seen = new Set<string>();
  for (const model of parsed.models) {
    const id = key(model.providerId, model.id);
    seen.add(id);
    const previous = before.get(id);
    if (previous === undefined) {
      added += 1;
      writes.push({
        ...model,
        firstSeenAt: stamp,
        unlistedAt: null,
        updatedAt: stamp,
      });
      continue;
    }
    const sameContent = contentOf(previous) === contentOf(model);
    if (sameContent && previous.unlistedAt === null) continue;
    if (previous.unlistedAt !== null) returned += 1;
    else changed += 1;
    writes.push({
      ...model,
      firstSeenAt: previous.firstSeenAt,
      unlistedAt: null,
      updatedAt: stamp,
    });
  }
  const enabled = new Set(
    (input.enabled ?? []).map((model) => key(model.providerId, model.modelId)),
  );
  let unlisted = 0;
  let listedBefore = 0;
  let enabledListedBefore = 0;
  let enabledUnlisted = 0;
  for (const previous of stored.models) {
    const id = key(previous.providerId, previous.id);
    if (previous.unlistedAt === null) {
      listedBefore += 1;
      if (enabled.has(id)) enabledListedBefore += 1;
    }
    if (seen.has(id) || previous.unlistedAt !== null) continue;
    unlisted += 1;
    if (enabled.has(id)) enabledUnlisted += 1;
    writes.push({ ...previous, unlistedAt: stamp, updatedAt: stamp });
  }
  return {
    writes,
    added,
    changed,
    returned,
    unlisted,
    listedBefore,
    enabledUnlisted,
    enabledListedBefore,
  };
}

function guardOf(
  input: Input,
  providers: ReturnType<typeof planProviders>,
  models: ReturnType<typeof planModels>,
): Guard {
  const share = (count: number, whole: number) =>
    whole === 0 ? 0 : count / whole;
  const reasons: GuardReason[] = [];
  if (
    share(models.unlisted, models.listedBefore) > UNLISTED_SHARE_LIMIT ||
    share(providers.unlisted, providers.listedBefore) > UNLISTED_SHARE_LIMIT
  )
    reasons.push("unlisted_share");
  if (
    models.enabledUnlisted >= ENABLED_UNLISTED_MIN_COUNT &&
    share(models.enabledUnlisted, models.enabledListedBefore) >
      UNLISTED_SHARE_LIMIT
  )
    reasons.push("enabled_unlisted_share");
  const listedAfter =
    models.listedBefore - models.unlisted + models.added + models.returned;
  // A database with rows but none listed has nothing to grow from: any listed model afterwards is growth.
  const grown =
    input.stored.models.length > 0 &&
    (models.listedBefore === 0
      ? listedAfter > 0
      : (listedAfter - models.listedBefore) / models.listedBefore >
        GROWTH_LIMIT);
  if (grown) reasons.push("growth");
  if (
    providers.newlyBlocked >= URL_CHANGED_MIN_COUNT &&
    share(providers.newlyBlocked, input.parsed.providers.length) >
      URL_CHANGED_SHARE_LIMIT
  )
    reasons.push("url_changed_share");
  if (input.parsed.skipped.oversizedProviders > 0)
    reasons.push("provider_size");
  return {
    tripped: reasons.length > 0,
    reasons,
    unlisted: models.unlisted,
    listed: models.listedBefore,
    listedAfter,
    providersUnlisted: providers.unlisted,
    providersListed: providers.listedBefore,
    enabledUnlisted: models.enabledUnlisted,
    enabledListed: models.enabledListedBefore,
    newlyBlocked: providers.newlyBlocked,
    providers: input.parsed.providers.length,
    oversizedProviders: input.parsed.skipped.oversizedProviders,
  };
}

export function planCatalog(input: Input): CatalogPlan {
  const stamp = input.now.toISOString();
  const providers = planProviders(input, stamp);
  const models = planModels(input, stamp);
  const { skipped } = input.parsed;
  return {
    write: { providers: providers.writes, models: models.writes },
    guard: guardOf(input, providers, models),
    summary: {
      providers: input.parsed.providers.length,
      models: input.parsed.models.length,
      newProviders: providers.added,
      newModels: models.added,
      changedModels: models.changed,
      unlistedModels: models.unlisted,
      returnedModels: models.returned,
      unlistedProviders: providers.unlisted,
      blockedProviders: providers.blocked,
      rejectedProviders: providers.rejected,
      retryProviders: providers.retry,
      skippedInvalid: skipped.invalid,
      skippedNoToolCalling: skipped.noToolCalling,
      skippedNotLanguageModel: skipped.notLanguageModel,
      skippedModelProviderOverride: skipped.modelProviderOverride,
      unsupportedProviders: skipped.unsupportedProviders,
      unknownProviders: skipped.unknownProviders,
      oversizedProviders: skipped.oversizedProviders,
    },
  };
}
