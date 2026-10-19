// SPDX-License-Identifier: Apache-2.0

// Decides what one fetch writes (#548), as a pure function of the parsed body, the stored rows and the verdicts on the
// providers' addresses. Nothing is deleted: a row that goes away upstream is written again with `unlistedAt` and keeps
// its last known data; one that returns clears it. Only rows that are new or changed are in the plan, so an unchanged
// day writes nothing. The guard says whether the plan would unlist an implausibly large share of what is listed; the
// service then refuses to apply it (the old state stays).
import type {
  CatalogWrite,
  FetchSummary,
  StoredModel,
  StoredProvider,
} from "./catalog.ts";
import type { ParsedModelsDev, ReducedModel } from "./parse.ts";
import { nextUrlState, type UrlCheck } from "./upstream-url.ts";

/** A fetch that would unlist more than this share of the listed models (or of the listed providers) is not applied. */
export const UNLISTED_SHARE_LIMIT = 0.1;

export type Guard = { tripped: boolean; unlisted: number; listed: number };

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

const key = (providerId: string, id: string) => `${providerId}\u0000${id}`;

function planProviders(input: Input, stamp: string) {
  const { parsed, stored, urlChecks } = input;
  const before = new Map(
    stored.providers.map((provider) => [provider.id, provider]),
  );
  const writes: StoredProvider[] = [];
  let blocked = 0;
  let rejected = 0;
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
    const url = nextUrlState(previous?.url, check);
    if (url.state === "url_changed") blocked += 1;
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
  return { writes, blocked, rejected, added, unlisted, listedBefore };
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
  let unlisted = 0;
  let listedBefore = 0;
  for (const previous of stored.models) {
    if (previous.unlistedAt === null) listedBefore += 1;
    if (
      seen.has(key(previous.providerId, previous.id)) ||
      previous.unlistedAt !== null
    )
      continue;
    unlisted += 1;
    writes.push({ ...previous, unlistedAt: stamp, updatedAt: stamp });
  }
  return { writes, added, changed, returned, unlisted, listedBefore };
}

export function planCatalog(input: Input): CatalogPlan {
  const stamp = input.now.toISOString();
  const providers = planProviders(input, stamp);
  const models = planModels(input, stamp);
  const share = (unlisted: number, listed: number) =>
    listed === 0 ? 0 : unlisted / listed;
  const { skipped } = input.parsed;
  return {
    write: { providers: providers.writes, models: models.writes },
    guard: {
      tripped:
        share(models.unlisted, models.listedBefore) > UNLISTED_SHARE_LIMIT ||
        share(providers.unlisted, providers.listedBefore) >
          UNLISTED_SHARE_LIMIT,
      unlisted: models.unlisted,
      listed: models.listedBefore,
    },
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
      skippedInvalid: skipped.invalid,
      skippedNoToolCalling: skipped.noToolCalling,
      skippedNotLanguageModel: skipped.notLanguageModel,
      skippedModelProviderOverride: skipped.modelProviderOverride,
      unsupportedProviders: skipped.unsupportedProviders,
      unknownProviders: skipped.unknownProviders,
    },
  };
}
