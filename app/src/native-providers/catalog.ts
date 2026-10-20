// SPDX-License-Identifier: Apache-2.0

// What a workspace on its own key may choose from the models.dev catalog, and what a claim serves of that choice (#555).
// Server side: it reads the catalog tables (`src/models-dev/`, #548). The catalog is the instance's; what a workspace is
// told of it is only what it needs to choose with its own key: the name of a provider, the name, the context size and (when
// models.dev states one) the price of a model. A workspace on the operator's key is never handed any of it (the routes and
// pages refuse it before they get here).
//
// **Offered** to a choice: a provider of `contracts/opencode-providers.v1.json` (a static key and a bundled SDK) that is not one
// of the registry's two, whose address is trusted (`url_changed` and refused addresses block it), that models.dev still lists
// and that has a model to choose. A model is offered while models.dev lists it. **Served** to a claim: the stored row, whether
// or not models.dev lists it now (decision of 2026-10-19 on #548: a model that disappears keeps working until the provider
// retires it), as long as the provider is supported and its address trusted.
import "server-only";
import type { ModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import {
  buildJobModelEntry,
  type JobModelEntry,
} from "../models-dev/job-entry.ts";
import { supportedProvider } from "../models-dev/opencode-providers.ts";
import { isUsable } from "../models-dev/upstream-url.ts";
import {
  nativeProviderIdOf,
  providerSlugOf,
} from "../native-cost/catalog-ref.ts";

export const NATIVE_CHOICE_REFUSAL_CODES = ["model_not_in_catalog"] as const;
export type NativeChoiceRefusalCode =
  (typeof NATIVE_CHOICE_REFUSAL_CODES)[number];

export const NATIVE_SERVE_REFUSAL_CODES = [
  /** The provider is not supported, its address is not trusted, or the catalog has no such provider. */
  "provider_unavailable",
  /** The catalog holds no row for the model (or the row makes no entry the contract allows). */
  "model_unavailable",
] as const;
export type NativeServeRefusalCode =
  (typeof NATIVE_SERVE_REFUSAL_CODES)[number];

/** A provider of the picker: the slug the key and the selection are stored under, the name people read. */
export type NativeProviderView = {
  id: string;
  label: string;
  /** How many listed models it has. */
  modelCount: number;
};

/** What models.dev states of a price, as exact decimal text of US dollars per million tokens. */
export type NativeModelPrice = {
  inputPerMillion: string;
  outputPerMillion: string;
};

/** A model of the picker. The strings are untrusted text from models.dev; they are rendered as text. */
export type NativeModelView = {
  id: string;
  name: string;
  contextTokens: number;
  outputTokens: number;
  reasoning: boolean;
  /** models.dev marks it `deprecated`: shown as a warning, still selectable. */
  deprecated: boolean;
  /** models.dev marks it `alpha`: shown as a warning, still selectable. */
  alpha: boolean;
  /** The price models.dev states; null when it states none or one we cannot read (the run is then bound by a token cap). */
  price: NativeModelPrice | null;
};

export type NativeChoice =
  | { ok: true; model: NativeModelView }
  | { ok: false; code: NativeChoiceRefusalCode };

export type NativeServed =
  | {
      ok: true;
      /** The per-job entry of #548: what the runner is told about the model. */
      entry: JobModelEntry;
      /** models.dev no longer lists the model: the last known row serves, and the settings say so. */
      unlisted: boolean;
    }
  | { ok: false; code: NativeServeRefusalCode };

export type NativeCatalogReader = {
  /** The providers to offer, sorted by name. */
  providers(): Promise<NativeProviderView[]>;
  /** Whether a key may be stored for this provider and a project may choose it. */
  providerAvailable(slug: string): Promise<boolean>;
  /** The listed models of an offered provider, by id; undefined when the provider is not offered. */
  models(slug: string): Promise<NativeModelView[] | undefined>;
  /** Whether a project may save this provider and model: only a listed model of an offered provider. */
  checkSelection(slug: string, modelId: string): Promise<NativeChoice>;
  /** The entry of the model a claim serves, or why it cannot be served (the job then fails closed). */
  resolve(slug: string, modelId: string): Promise<NativeServed>;
};

export type NativeCatalogDependencies = {
  models: Pick<
    ModelsDevRepository,
    | "listProviders"
    | "listedModelCounts"
    | "getProvider"
    | "listModelsOf"
    | "getModel"
  >;
  /** The providers of the app's registry, which keep their own path (they are never offered here). */
  legacyProviders: readonly string[];
};

function offered(
  provider: StoredProvider | undefined,
): provider is StoredProvider {
  return (
    provider !== undefined &&
    provider.unlistedAt === null &&
    supportedProvider(provider.id) !== undefined &&
    isUsable(provider.url)
  );
}

function priceOf(model: StoredModel): NativeModelPrice | null {
  const { cost } = model;
  if (cost === null) return null;
  // A price with a part we cannot read is no price: the run is bound by its token cap, not by a figure that may be wrong.
  if ((cost.unknown ?? []).length > 0) return null;
  return { inputPerMillion: cost.input, outputPerMillion: cost.output };
}

function viewOf(model: StoredModel): NativeModelView {
  return {
    id: model.id,
    name: model.name,
    contextTokens: model.limit.context,
    outputTokens: model.limit.output,
    reasoning: model.reasoning,
    deprecated: model.status === "deprecated",
    alpha: model.status === "alpha",
    price: priceOf(model),
  };
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function createNativeCatalogReader({
  models,
  legacyProviders,
}: NativeCatalogDependencies): NativeCatalogReader {
  const providerIdOf = (slug: string) =>
    nativeProviderIdOf(slug, legacyProviders);

  async function offeredProvider(slug: string) {
    const providerId = providerIdOf(slug);
    if (providerId === null) return undefined;
    const provider = await models.getProvider(providerId);
    return offered(provider) ? provider : undefined;
  }

  return {
    async providers() {
      const [providers, counts] = await Promise.all([
        models.listProviders(),
        models.listedModelCounts(),
      ]);
      const view: NativeProviderView[] = [];
      for (const provider of providers) {
        if (!offered(provider)) continue;
        const slug = providerSlugOf(provider.id);
        if (slug === null || providerIdOf(slug) === null) continue;
        const modelCount = counts.get(provider.id) ?? 0;
        if (modelCount === 0) continue;
        view.push({ id: slug, label: provider.name, modelCount });
      }
      return view.sort((a, b) => a.label.localeCompare(b.label) || byId(a, b));
    },

    async providerAvailable(slug) {
      return (await offeredProvider(slug)) !== undefined;
    },

    async models(slug) {
      const provider = await offeredProvider(slug);
      if (provider === undefined) return undefined;
      return (await models.listModelsOf(provider.id))
        .filter((model) => model.unlistedAt === null)
        .map(viewOf)
        .sort(byId);
    },

    async checkSelection(slug, modelId) {
      const provider = await offeredProvider(slug);
      const model =
        provider === undefined
          ? undefined
          : await models.getModel(provider.id, modelId);
      if (model === undefined || model.unlistedAt !== null)
        return { ok: false, code: "model_not_in_catalog" };
      return { ok: true, model: viewOf(model) };
    },

    async resolve(slug, modelId) {
      const providerId = providerIdOf(slug);
      const provider =
        providerId === null ? undefined : await models.getProvider(providerId);
      if (
        provider === undefined ||
        supportedProvider(provider.id) === undefined ||
        !isUsable(provider.url)
      )
        return { ok: false, code: "provider_unavailable" };
      const model = await models.getModel(provider.id, modelId);
      if (model === undefined) return { ok: false, code: "model_unavailable" };
      const built = buildJobModelEntry(provider, model);
      if (!built.ok)
        return {
          ok: false,
          code:
            built.code === "provider_unsupported" ||
            built.code === "provider_url_blocked"
              ? "provider_unavailable"
              : "model_unavailable",
        };
      return {
        ok: true,
        entry: built.entry,
        unlisted: model.unlistedAt !== null,
      };
    },
  };
}
