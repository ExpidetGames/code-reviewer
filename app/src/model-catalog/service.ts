// SPDX-License-Identifier: LicenseRef-Proprietary

// The model catalog (#425, ADR 0005, 2.6): the operator's list of the models that workspaces on the operator's key may
// use, and the two instance defaults. The one place that creates, changes, releases and retires an entry and that
// reads and writes the instance setting `catalog_defaults`, so what is stored always passes the rules here, and what is
// read is checked again (a default that went stale reads as none, and a job of a managed workspace fails closed).
//
// Nothing here reads the catalog at claim time and nothing shows it: the admin portal, the selection settings and the
// claim come with later issues (src/model-catalog/README.md).
import type { CatalogRepository } from "../db/repositories/catalog-repository.ts";
import { CatalogNameTakenError } from "../db/repositories/catalog-repository.ts";
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { isModelId, LLM_PROVIDERS, type LlmProvider } from "../llm/config.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  CATALOG_KINDS,
  canTransition,
  checkDescription,
  checkEntryName,
  descriptionRevealsModel,
  nameRevealsModel,
  type CatalogDefaults,
  type CatalogEntry,
} from "./entries.ts";
import type { CatalogErrorCode } from "./errors.ts";
import { toMemberEntry, type MemberCatalogEntry } from "./member.ts";

export type Refused = { ok: false; code: CatalogErrorCode; field?: string };
export type EntryResult = { ok: true; entry: CatalogEntry } | Refused;
/** The model behind a released entry changes only when the caller confirms it; nothing was written. */
export type ModelChangeNotConfirmed = {
  ok: false;
  code: "model_change_not_confirmed";
  /** How many projects use the entry, read when the confirmation was decided. */
  projects: number;
};
export type UpdateResult =
  | {
      ok: true;
      entry: CatalogEntry;
      /** Set when the model or the provider behind a released entry changed: how many projects select it. */
      modelChange: { projects: number } | null;
    }
  | Refused
  | ModelChangeNotConfirmed;
/** What the caller of `update` says about the change of a model. */
export type UpdateOptions = {
  /** True when the person was told how many projects use the entry. Without it the model behind a released entry stays. */
  confirmModelChange?: boolean;
};
export type DefaultsResult = { ok: true; defaults: CatalogDefaults } | Refused;
/** What the check of a model found: `verified` is false when the provider could not be asked (a Diff model is accepted then). */
export type CheckModelResult = { ok: true; verified: boolean } | Refused;
/** How many entries are released for each kind and whether the kind has a default: numbers and nothing else (#429). */
export type CatalogSummary = Record<
  ProjectReviewKind,
  { released: number; hasDefault: boolean }
>;

/** Where the audit line of a change of model goes (the console in production, a list in tests). */
export type CatalogLogger = { info(line: string): void };

export type CatalogService = {
  /** Every entry, whole: the operator's view. */
  list(): Promise<CatalogEntry[]>;
  get(id: string): Promise<CatalogEntry | undefined>;
  /** A new entry is a draft; it is not checked against the provider until it is released. */
  create(input: unknown, updatedBy: string | null): Promise<EntryResult>;
  /**
   * Changes the given fields of an entry. A change of the model, the provider or the kinds of a released entry is
   * checked again like a release, writes an audit line (the entry, the person, the model before and after, the number
   * of projects) and reports that number. The name is checked against the model it ends up with.
   *
   * A change of the model or the provider of a released entry is refused with `model_change_not_confirmed` and the
   * number of projects, and writes nothing, unless `options.confirmModelChange` is true. The decision is made on the
   * entry that the write is pinned to (its `updatedAt`), so an entry released in between cannot skip it: the write then
   * finds the entry changed and ends as `catalog_conflict`.
   */
  update(
    id: string,
    input: unknown,
    updatedBy: string | null,
    options?: UpdateOptions,
  ): Promise<UpdateResult>;
  /** Draft or retired to released, after the provider's metadata vouches for the model for every kind it serves. */
  release(id: string, updatedBy: string | null): Promise<EntryResult>;
  /** Released to retired. Not while the entry is an instance default. */
  retire(id: string, updatedBy: string | null): Promise<EntryResult>;
  /**
   * Puts the entries in the given order: `ids` is every entry's id once, first to last, and each entry gets its position as
   * its sort order, all in one transaction. A list that is not exactly the entries (one was added, deleted or left out
   * meanwhile) is `catalog_conflict` and writes nothing; a list that is no list of ids is `request_invalid`.
   */
  reorder(
    ids: unknown,
    updatedBy: string | null,
  ): Promise<{ ok: true } | Refused>;
  /** Deletes a draft; a released or retired entry is never deleted (its id stays in the mask list and in old usage). */
  remove(id: string): Promise<{ ok: true } | Refused>;
  /**
   * How many projects use the entry: the number the confirmation of a change of model shows. It counts the projects
   * that select the entry and, for an instance default, the projects of workspaces on the operator's key that have
   * chosen no entry for the kind they run and so fall back to it (ADR 0005, 2.7).
   */
  usedByProjects(id: string): Promise<number>;
  /** `usedByProjects` of every entry in one pass over the projects (an entry nobody uses is absent). */
  projectCounts(): Promise<ReadonlyMap<string, number>>;
  /** The instance defaults, each a released entry that serves the kind, else null. */
  defaults(): Promise<CatalogDefaults>;
  /** Replaces both defaults: `{ diff, dynamic }`, each an entry id or null. Nothing is stored on a refusal. */
  setDefaults(
    input: unknown,
    updatedBy: string | null,
  ): Promise<DefaultsResult>;
  /**
   * Asks the provider's metadata what release would ask, for a model that is not an entry yet or not released yet (the
   * "Check model" button of the admin portal). `{ provider, modelId, kinds }`; nothing is stored.
   */
  checkModel(input: unknown): Promise<CheckModelResult>;
  /** The numbers the overview of the admin portal shows: released entries per kind, and whether the kind has a default. */
  summary(): Promise<CatalogSummary>;
  /** What a member may see: released and retired entries with no provider and no model id. */
  memberEntries(): Promise<MemberCatalogEntry[]>;
  /** The model id of every entry of every status: with the models of a job, the ids to mask in what a member reads. */
  allCatalogModelIds(): Promise<string[]>;
};

function refused(code: CatalogErrorCode, field?: string): Refused {
  return field === undefined ? { ok: false, code } : { ok: false, code, field };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isKind(value: unknown): value is ProjectReviewKind {
  return CATALOG_KINDS.some((kind) => kind === value);
}

/** The kinds in the order of the catalog, once each; undefined when the value is not a non-empty list of kinds. */
function checkKinds(value: unknown): ProjectReviewKind[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every(isKind)) return undefined;
  return CATALOG_KINDS.filter((kind) => value.includes(kind));
}

function isProvider(value: unknown): value is LlmProvider {
  return LLM_PROVIDERS.some((provider) => provider === value);
}

function sameKinds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((kind) => b.includes(kind));
}

/** The shape of a stored `catalog_defaults`: both keys, each text or null. Anything else reads as no default. */
export function readStoredDefaults(value: unknown): CatalogDefaults {
  const stored = isPlainObject(value) ? value : {};
  return {
    diff: typeof stored.diff === "string" ? stored.diff : null,
    dynamic: typeof stored.dynamic === "string" ? stored.dynamic : null,
  };
}

export function createCatalogService(deps: {
  catalog: CatalogRepository;
  settings: Pick<InstanceSettingsRepository, "get" | "set">;
  modelCapabilities: ModelCapabilityChecker;
  logger: CatalogLogger;
}): CatalogService {
  const { catalog, settings, modelCapabilities, logger } = deps;

  async function storedDefaults(): Promise<CatalogDefaults> {
    return readStoredDefaults(await settings.get("catalog_defaults"));
  }

  /**
   * The refusal when the provider's metadata does not vouch for the model, undefined when it does. A Dynamic entry needs
   * tool calling and tool choice and must be verifiable (operator configuration, not a user's choice); a Diff entry
   * needs no tool support and may be unverifiable (the provider is unreachable), but a model the provider does not know
   * is a typo that would fail every job. An entry that serves both is held to the stricter rule. `verified` is false
   * when the provider could not be asked.
   */
  async function judgeModel(
    provider: LlmProvider,
    modelId: string,
    kinds: readonly ProjectReviewKind[],
  ): Promise<{ refusal: Refused | undefined; verified: boolean }> {
    const result = await modelCapabilities.check(modelId, { provider });
    const verified = result.outcome !== "unverifiable";
    const dynamic = kinds.includes("dynamic");
    if (result.outcome === "unknown_model")
      return {
        refusal: refused(dynamic ? "DYNAMIC_MODEL_UNKNOWN" : "MODEL_UNKNOWN"),
        verified,
      };
    if (!dynamic) return { refusal: undefined, verified };
    if (result.outcome === "unsupported")
      return { refusal: refused("DYNAMIC_MODEL_TOOLS_UNSUPPORTED"), verified };
    if (result.outcome === "unverifiable")
      return { refusal: refused("DYNAMIC_MODEL_UNVERIFIED"), verified };
    return { refusal: undefined, verified };
  }

  async function refuseUnsuitableModel(
    provider: LlmProvider,
    modelId: string,
    kinds: readonly ProjectReviewKind[],
  ): Promise<Refused | undefined> {
    return (await judgeModel(provider, modelId, kinds)).refusal;
  }

  /** The stored defaults read against the entries: one that is no longer fit for its kind reads as none. */
  function fitDefaults(
    stored: CatalogDefaults,
    entries: readonly CatalogEntry[],
  ): CatalogDefaults {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const fit = (kind: ProjectReviewKind): string | null => {
      const id = stored[kind];
      const entry = id === null ? undefined : byId.get(id);
      return entry?.status === "released" && entry.kinds.includes(kind)
        ? entry.id
        : null;
    };
    return { diff: fit("diff"), dynamic: fit("dynamic") };
  }

  async function projectCounts(): Promise<ReadonlyMap<string, number>> {
    const defaults = fitDefaults(await storedDefaults(), await catalog.list());
    return catalog.countProjectsUsing(defaults);
  }

  async function usedByProjects(id: string): Promise<number> {
    return (await projectCounts()).get(id) ?? 0;
  }

  async function writeOrRefuse<T>(
    write: () => Promise<T | undefined>,
  ): Promise<T | Refused> {
    try {
      return (await write()) ?? refused("catalog_conflict");
    } catch (cause) {
      if (cause instanceof CatalogNameTakenError)
        return refused("catalog_name_taken");
      throw cause;
    }
  }

  async function change(
    id: string,
    to: "released" | "retired",
    updatedBy: string | null,
  ): Promise<EntryResult> {
    const entry = await catalog.get(id);
    if (entry === undefined) return refused("CATALOG_ENTRY_UNKNOWN");
    if (!canTransition(entry.status, to))
      return refused("catalog_transition_invalid");
    if (to === "released") {
      if (!isProvider(entry.provider))
        return refused("PROVIDER_UNKNOWN", "provider");
      const unsuitable = await refuseUnsuitableModel(
        entry.provider,
        entry.modelId,
        entry.kinds,
      );
      if (unsuitable !== undefined) return unsuitable;
    } else {
      // Check then act, harmless: see `setDefaults`. A default set between this read and the write below is read as
      // none by `defaults()`, because the entry is retired by then.
      const defaults = await storedDefaults();
      if (defaults.diff === id || defaults.dynamic === id)
        return refused("catalog_entry_is_default");
    }
    const moved = await writeOrRefuse(() =>
      catalog.setStatus(id, entry.status, to, updatedBy, entry.updatedAt),
    );
    return "ok" in moved ? moved : { ok: true, entry: moved };
  }

  return {
    list: () => catalog.list(),
    get: (id) => catalog.get(id),

    async create(input, updatedBy) {
      if (!isPlainObject(input)) return refused("request_invalid");
      const name = checkEntryName(input.name);
      if (!name.ok) return refused(name.code, "name");
      const description = checkDescription(input.description);
      if (!description.ok) return refused(description.code, "description");
      const provider = input.provider;
      if (!isProvider(provider)) return refused("PROVIDER_UNKNOWN", "provider");
      const modelId = input.modelId;
      if (typeof modelId !== "string" || !isModelId(modelId, provider))
        return refused("model_id_invalid", "modelId");
      const kinds = checkKinds(input.kinds);
      if (kinds === undefined) return refused("kinds_invalid", "kinds");
      const sortOrder = input.sortOrder ?? 0;
      if (!Number.isSafeInteger(sortOrder) || typeof sortOrder !== "number")
        return refused("request_invalid", "sortOrder");
      if (nameRevealsModel(name.name, { provider, modelId }))
        return refused("name_reveals_model", "name");
      if (
        description.description !== null &&
        descriptionRevealsModel(description.description, {
          provider,
          modelId,
        })
      )
        return refused("description_invalid", "description");
      const created = await writeOrRefuse(() =>
        catalog.insert(
          {
            name: name.name,
            nameKey: name.key,
            description: description.description,
            provider,
            modelId,
            kinds,
            sortOrder,
          },
          updatedBy,
        ),
      );
      return "ok" in created ? created : { ok: true, entry: created };
    },

    async update(id, input, updatedBy, options = {}) {
      if (!isPlainObject(input)) return refused("request_invalid");
      const entry = await catalog.get(id);
      if (entry === undefined) return refused("CATALOG_ENTRY_UNKNOWN");

      let name = entry.name;
      let nameKey: string | undefined;
      if (input.name !== undefined) {
        const checked = checkEntryName(input.name);
        if (!checked.ok) return refused(checked.code, "name");
        name = checked.name;
        nameKey = checked.key;
      }
      let description = entry.description;
      if (input.description !== undefined) {
        const checked = checkDescription(input.description);
        if (!checked.ok) return refused(checked.code, "description");
        description = checked.description;
      }
      let provider = entry.provider;
      if (input.provider !== undefined) {
        if (!isProvider(input.provider))
          return refused("PROVIDER_UNKNOWN", "provider");
        provider = input.provider;
      }
      // A stored provider that the registry no longer lists (an adapter was removed) cannot be edited until it is changed.
      if (!isProvider(provider)) return refused("PROVIDER_UNKNOWN", "provider");
      let modelId = entry.modelId;
      if (input.modelId !== undefined) {
        if (
          typeof input.modelId !== "string" ||
          !isModelId(input.modelId, provider)
        )
          return refused("model_id_invalid", "modelId");
        modelId = input.modelId;
      }
      let kinds = entry.kinds;
      if (input.kinds !== undefined) {
        const checked = checkKinds(input.kinds);
        if (checked === undefined) return refused("kinds_invalid", "kinds");
        kinds = checked;
      }
      let sortOrder = entry.sortOrder;
      if (input.sortOrder !== undefined) {
        if (
          typeof input.sortOrder !== "number" ||
          !Number.isSafeInteger(input.sortOrder)
        )
          return refused("request_invalid", "sortOrder");
        sortOrder = input.sortOrder;
      }
      if (nameRevealsModel(name, { provider, modelId }))
        return refused("name_reveals_model", "name");
      if (
        description !== null &&
        descriptionRevealsModel(description, { provider, modelId })
      )
        return refused("description_invalid", "description");

      const modelChanged =
        provider !== entry.provider || modelId !== entry.modelId;
      const kindsChanged = !sameKinds(kinds, entry.kinds);
      if (
        entry.status === "released" &&
        modelChanged &&
        options.confirmModelChange !== true
      )
        return {
          ok: false,
          code: "model_change_not_confirmed",
          projects: await usedByProjects(id),
        };
      if (entry.status === "released" && (modelChanged || kindsChanged)) {
        const defaults = await storedDefaults();
        for (const kind of CATALOG_KINDS)
          if (defaults[kind] === id && !kinds.includes(kind))
            return refused("catalog_entry_is_default", kind);
        const unsuitable = await refuseUnsuitableModel(
          provider,
          modelId,
          kinds,
        );
        if (unsuitable !== undefined) return unsuitable;
      }

      const updated = await writeOrRefuse(() =>
        catalog.update(
          id,
          {
            ...(nameKey === undefined ? {} : { name, nameKey }),
            description,
            provider,
            modelId,
            kinds,
            sortOrder,
          },
          updatedBy,
          entry.updatedAt,
        ),
      );
      if ("ok" in updated) return updated;

      if (!(entry.status === "released" && modelChanged))
        return { ok: true, entry: updated, modelChange: null };
      const projects = await usedByProjects(id);
      logger.info(
        `model catalog: the model behind released entry ${id} changed from ${entry.provider}:${entry.modelId} to ${provider}:${modelId} by ${updatedBy ?? "the system"}; ${projects} ${projects === 1 ? "project uses" : "projects use"} it`,
      );
      return { ok: true, entry: updated, modelChange: { projects } };
    },

    release: (id, updatedBy) => change(id, "released", updatedBy),
    retire: (id, updatedBy) => change(id, "retired", updatedBy),

    async reorder(ids, updatedBy) {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
        return refused("request_invalid", "order");
      const order: string[] = ids;
      if (new Set(order).size !== order.length)
        return refused("request_invalid", "order");
      return (await catalog.reorder(order, updatedBy))
        ? { ok: true }
        : refused("catalog_conflict");
    },

    async remove(id) {
      const entry = await catalog.get(id);
      if (entry === undefined) return refused("CATALOG_ENTRY_UNKNOWN");
      if (entry.status !== "draft") return refused("catalog_entry_not_draft");
      // A draft that was released in the meantime is not deleted: the statement itself only deletes a draft.
      return (await catalog.deleteDraft(id))
        ? { ok: true }
        : refused("catalog_entry_not_draft");
    },

    usedByProjects,
    projectCounts,

    async defaults() {
      return fitDefaults(await storedDefaults(), await catalog.list());
    },

    async checkModel(input) {
      if (!isPlainObject(input)) return refused("request_invalid");
      const provider = input.provider;
      if (!isProvider(provider)) return refused("PROVIDER_UNKNOWN", "provider");
      const modelId = input.modelId;
      if (typeof modelId !== "string" || !isModelId(modelId, provider))
        return refused("model_id_invalid", "modelId");
      const kinds = checkKinds(input.kinds);
      if (kinds === undefined) return refused("kinds_invalid", "kinds");
      const { refusal, verified } = await judgeModel(provider, modelId, kinds);
      return refusal ?? { ok: true, verified };
    },

    async summary() {
      const entries = await catalog.list();
      const defaults = fitDefaults(await storedDefaults(), entries);
      const of = (kind: ProjectReviewKind) => ({
        released: entries.filter(
          (entry) => entry.status === "released" && entry.kinds.includes(kind),
        ).length,
        hasDefault: defaults[kind] !== null,
      });
      return { diff: of("diff"), dynamic: of("dynamic") };
    },

    // Check then act, and harmless: `retire`, `update` (a narrowed kind) and this method can interleave, so a default
    // may be stored for an entry that was retired a moment ago. Nothing reads the stored value directly: `defaults()`
    // checks it again against the entry's current status and kinds and reads a stale one as none (README, "Defaults").
    async setDefaults(input, updatedBy) {
      if (!isPlainObject(input)) return refused("request_invalid");
      const chosen: CatalogDefaults = { diff: null, dynamic: null };
      for (const kind of CATALOG_KINDS) {
        const id = input[kind];
        if (id === null) continue;
        if (typeof id !== "string") return refused("request_invalid", kind);
        const entry = await catalog.get(id);
        if (entry === undefined) return refused("CATALOG_ENTRY_UNKNOWN", kind);
        if (entry.status !== "released")
          return refused("CATALOG_ENTRY_NOT_RELEASED", kind);
        if (!entry.kinds.includes(kind))
          return refused("CATALOG_ENTRY_KIND_MISMATCH", kind);
        chosen[kind] = entry.id;
      }
      await settings.set("catalog_defaults", chosen, updatedBy);
      return { ok: true, defaults: chosen };
    },

    async memberEntries() {
      return (await catalog.listMemberEntries()).map(toMemberEntry);
    },

    allCatalogModelIds: () => catalog.allModelIds(),
  };
}
