// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog as the admin portal uses it (#429): the rules stay in the catalog service (service.ts); this adds what only
// the portal needs. The view of every entry with the number of projects that use it, the confirmation before the model
// behind a released entry changes (decision C6: the answer carries the number, nothing is written until the request says
// `confirmModelChange: true`), and the field a refusal belongs to. Nothing here is reachable by a member of a workspace.
import type { CatalogEntry } from "./entries.ts";
import type { CatalogErrorCode } from "./errors.ts";
import type { CatalogService } from "./service.ts";
import type {
  AdminCatalogEntry,
  AdminCatalogProvider,
  AdminCatalogView,
} from "./admin-view.ts";

export type AdminRefusal = {
  ok: false;
  code: CatalogErrorCode;
  /** The field of the form the refusal belongs to, when it belongs to one. */
  field?: string;
};
export type AdminFailure =
  | AdminRefusal
  | {
      ok: false;
      code: "model_change_not_confirmed";
      /** How many projects use the entry. */
      projects: number;
    };
export type AdminChange =
  | {
      ok: true;
      catalog: AdminCatalogView;
      entry?: AdminCatalogEntry;
      /** Set when the model behind a released entry changed: how many projects use it. */
      modelChange?: { projects: number } | null;
    }
  | AdminFailure;
/** The answer of the check of a model: what the provider's metadata said, or why it does not vouch for the model. */
export type AdminCheck = { ok: true; verified: boolean } | AdminRefusal;

export type CatalogAdminService = {
  view(): Promise<AdminCatalogView>;
  create(actorId: string, input: unknown): Promise<AdminChange>;
  update(actorId: string, id: string, input: unknown): Promise<AdminChange>;
  release(actorId: string, id: string): Promise<AdminChange>;
  retire(actorId: string, id: string): Promise<AdminChange>;
  remove(id: string): Promise<AdminChange>;
  /** Puts the entries in the order of `{ order: [id, ...] }`, every entry once, in one transaction. */
  reorder(actorId: string, input: unknown): Promise<AdminChange>;
  setDefaults(actorId: string, input: unknown): Promise<AdminChange>;
  check(input: unknown): Promise<AdminCheck>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(result: {
  code: CatalogErrorCode;
  field?: string;
}): AdminRefusal {
  // A name that is taken is a problem of the name field, which the service does not say.
  const field =
    result.field ?? (result.code === "catalog_name_taken" ? "name" : undefined);
  return field === undefined
    ? { ok: false, code: result.code }
    : { ok: false, code: result.code, field };
}

export function createCatalogAdminService({
  catalog,
  providers,
}: {
  catalog: CatalogService;
  /** The providers an entry can name, in the order of the registry. */
  providers: () => AdminCatalogProvider[];
}): CatalogAdminService {
  function toAdminEntry(
    entry: CatalogEntry,
    usedByProjects: number,
  ): AdminCatalogEntry {
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      provider: entry.provider,
      modelId: entry.modelId,
      kinds: [...entry.kinds],
      status: entry.status,
      sortOrder: entry.sortOrder,
      updatedAt: entry.updatedAt,
      usedByProjects,
    };
  }

  async function view(): Promise<AdminCatalogView> {
    const [entries, used] = await Promise.all([
      catalog.list(),
      catalog.projectCounts(),
    ]);
    return {
      entries: entries.map((entry) =>
        toAdminEntry(entry, used.get(entry.id) ?? 0),
      ),
      defaults: await catalog.defaults(),
      providers: providers(),
    };
  }

  async function changed(
    entry: CatalogEntry | undefined,
    extra: { modelChange?: { projects: number } | null } = {},
  ): Promise<AdminChange> {
    const catalogView = await view();
    const shown =
      entry === undefined
        ? undefined
        : catalogView.entries.find((candidate) => candidate.id === entry.id);
    return {
      ok: true,
      catalog: catalogView,
      ...(shown === undefined ? {} : { entry: shown }),
      ...extra,
    };
  }

  return {
    view,

    async create(actorId, input) {
      const result = await catalog.create(input, actorId);
      return result.ok ? changed(result.entry) : failure(result);
    },

    async update(actorId, id, input) {
      if (!isPlainObject(input)) return { ok: false, code: "request_invalid" };
      const { confirmModelChange, ...fields } = input;
      if (confirmModelChange !== undefined && confirmModelChange !== true)
        return {
          ok: false,
          code: "request_invalid",
          field: "confirmModelChange",
        };
      // The service decides on the entry it writes: reading the entry here as well would be a second look that a release
      // in between could contradict.
      const result = await catalog.update(id, fields, actorId, {
        confirmModelChange: confirmModelChange === true,
      });
      if (!result.ok && result.code === "model_change_not_confirmed")
        return result;
      return result.ok
        ? changed(result.entry, { modelChange: result.modelChange })
        : failure(result);
    },

    async release(actorId, id) {
      const result = await catalog.release(id, actorId);
      return result.ok ? changed(result.entry) : failure(result);
    },

    async retire(actorId, id) {
      const result = await catalog.retire(id, actorId);
      return result.ok ? changed(result.entry) : failure(result);
    },

    async remove(id) {
      const result = await catalog.remove(id);
      return result.ok ? changed(undefined) : failure(result);
    },

    async reorder(actorId, input) {
      if (!isPlainObject(input))
        return { ok: false, code: "request_invalid", field: "order" };
      const result = await catalog.reorder(input.order, actorId);
      return result.ok ? changed(undefined) : failure(result);
    },

    async setDefaults(actorId, input) {
      const result = await catalog.setDefaults(input, actorId);
      return result.ok ? changed(undefined) : failure(result);
    },

    async check(input) {
      const result = await catalog.checkModel(input);
      return result.ok ? result : failure(result);
    },
  };
}
