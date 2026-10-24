// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "LLM" section of the settings form (#656): a provider dropdown, then a model dropdown, and nothing else, in both key
// modes. A workspace on its own key picks one of its providers (the registry's and the catalog providers it holds a key for)
// and then one of the models of that provider; one on the operator's key sees the one provider "Our models" and the entries
// of the catalog by the names the operator gave them (never a vendor or a model id, ADR 0005). The model list follows the
// provider. The section is for one review kind: the one the form has selected.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { alertVariants } from "../../components/ui/alert.tsx";
import { FieldLabel } from "../../components/ui/field.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import Link from "next/link";
import {
  MODEL_CHOICE_CHOSEN_UNAVAILABLE,
  MODEL_CHOICE_DEFAULT_OPTION,
  MODEL_CHOICE_LOCKED_BADGE,
  MODEL_CHOICE_NONE_OFFERED,
  MODEL_CHOICE_PROVIDER,
  MODEL_CHOICE_RETIRED_BADGE,
} from "../../copy/model-choice.ts";
import type { NativeModelView } from "../../native-providers/catalog.ts";
import {
  browserCatalogModelsApi,
  type CatalogModelsApi,
} from "../../native-providers/ui/api.ts";
import { OwnKeyCostNote } from "../../native-providers/ui/own-key-cost-note.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import type { CatalogChoice } from "../catalog-selection.ts";
import {
  ModelSelect,
  withCurrentModel,
  type ModelOption,
} from "./model-select.tsx";
import { ProviderSelect, type ProviderOption } from "./provider-select.tsx";
import { SettingsCard, type SettingsOrigin } from "./settings-fields.tsx";

/** The provider and the model of a workspace on its own key, for the review kind the form shows. */
export type OwnLlmChoice = {
  providerName: "provider" | "dynamicProvider";
  modelName: "model" | "dynamicModel";
  providers: readonly ProviderOption[];
  provider: string;
  providerOrigin: SettingsOrigin;
  providerError: string | undefined;
  model: string;
  modelError: string | undefined;
  onProvider: (provider: string) => void;
  onModel: (model: string) => void;
  /** The models of a provider of the registry, to choose from. */
  registryModels: readonly string[];
  /** Set while the chosen provider is one of the models.dev catalog: its models are fetched, not listed here. */
  catalog?: { label: string; tokenCap: number; billingOn: boolean };
  /** The address note of a catalog provider that moved (#588). */
  addressNote?: ReactNode;
  /** The form offers the catalog providers the workspace holds a key for: say where to add the key of another. */
  keysHint: boolean;
  /** One line after a change the person did not ask for by name (the fallback model went with the provider). */
  notice?: string;
};

/** The choice of a workspace on the operator's key: one entry of the catalog for the review kind. */
export type ManagedLlmChoice = {
  choices: readonly CatalogChoice[];
  /** The id of the entry in force, or null: none, the default of the instance applies. */
  value: string | null;
  error: string | undefined;
  /** `null` takes the choice back. */
  onChange: (id: string | null) => void;
  /** The text of the option that takes the choice back, when the default is an entry the workspace chose (#676). */
  defaultLabel?: string;
};

const DEFAULT_OPTION = "__instance_default__";

function useCatalogModels(
  workspaceSlug: string,
  provider: string | undefined,
  api: CatalogModelsApi | undefined,
): {
  state: "loading" | "failed" | "ready";
  models: readonly NativeModelView[];
} {
  const client = useMemo(
    () => api ?? browserCatalogModelsApi(workspaceSlug),
    [api, workspaceSlug],
  );
  // What the route answered for which provider; an answer for another provider than the one shown is not an answer yet.
  const [fetched, setFetched] = useState<{
    provider: string;
    models: readonly NativeModelView[] | null;
  } | null>(null);
  useEffect(() => {
    if (provider === undefined) return;
    let current = true;
    void client.models(provider).then((result) => {
      if (current)
        setFetched({
          provider,
          models: result.ok ? result.data.models : null,
        });
    });
    return () => {
      current = false;
    };
  }, [client, provider]);
  if (provider === undefined || fetched?.provider !== provider)
    return { state: "loading", models: [] };
  return fetched.models === null
    ? { state: "failed", models: [] }
    : { state: "ready", models: fetched.models };
}

function OwnKeyChoice({
  workspaceSlug,
  choice,
  disabled,
  catalogApi,
}: {
  workspaceSlug: string;
  choice: OwnLlmChoice;
  disabled: boolean;
  catalogApi: CatalogModelsApi | undefined;
}) {
  const catalogProvider =
    choice.catalog === undefined ? undefined : choice.provider;
  const loaded = useCatalogModels(workspaceSlug, catalogProvider, catalogApi);
  const options: ModelOption[] =
    choice.catalog === undefined
      ? choice.registryModels.map((id) => ({ id, label: id }))
      : loaded.models.map((model) => ({
          id: model.id,
          label: model.name,
          ...(model.deprecated ? { note: "deprecated" } : {}),
        }));
  const chosen = loaded.models.find((model) => model.id === choice.model);
  return (
    <>
      <ProviderSelect
        workspaceSlug={workspaceSlug}
        name={choice.providerName}
        label="Provider"
        value={choice.provider}
        options={choice.providers}
        origin={choice.providerOrigin}
        error={choice.providerError}
        onChange={choice.onProvider}
      />
      {choice.notice === undefined ? null : (
        <p className="text-sm text-muted-foreground" data-llm-notice="">
          {choice.notice}
        </p>
      )}
      {choice.keysHint ? (
        <p className="text-sm text-muted-foreground">
          Only providers you have a key for are listed. Add a key on the{" "}
          <Link
            href={workspacePath(workspaceSlug, "/settings/llm")}
            className="font-semibold underline underline-offset-4"
          >
            LLM
          </Link>{" "}
          page.
        </p>
      ) : null}
      <ModelSelect
        name={choice.modelName}
        label="Model"
        value={choice.model}
        options={withCurrentModel(
          options,
          loaded.state === "ready" || choice.catalog === undefined
            ? choice.model
            : "",
        )}
        onChange={choice.onModel}
        error={choice.modelError}
        disabled={disabled}
        loading={choice.catalog !== undefined && loaded.state === "loading"}
      />
      {loaded.state === "failed" ? (
        <Alert variant="destructive">
          The models of {choice.catalog?.label} could not be loaded. Reload the
          page and try again.
        </Alert>
      ) : null}
      {loaded.state === "ready" && loaded.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The catalog lists no model of {choice.catalog?.label} that can call
          tools.
        </p>
      ) : null}
      {choice.addressNote}
      {choice.catalog !== undefined &&
      choice.model !== "" &&
      loaded.state === "ready" ? (
        <OwnKeyCostNote
          price={chosen?.price ?? null}
          tokenCap={choice.catalog.tokenCap}
          billingOn={choice.catalog.billingOn}
        />
      ) : null}
    </>
  );
}

function badgeOf(choice: CatalogChoice): string | undefined {
  if (choice.available) return undefined;
  return choice.reason === "CATALOG_ENTRY_NOT_RELEASED"
    ? MODEL_CHOICE_RETIRED_BADGE
    : MODEL_CHOICE_LOCKED_BADGE;
}

function ManagedChoice({
  workspaceSlug,
  choice,
  disabled,
  fieldName,
}: {
  workspaceSlug: string;
  choice: ManagedLlmChoice;
  disabled: boolean;
  fieldName: string;
}) {
  const chosenUnavailable =
    choice.value !== null &&
    choice.choices.find((entry) => entry.id === choice.value)?.available !==
      true;
  const options: ModelOption[] = [
    {
      id: DEFAULT_OPTION,
      label: choice.defaultLabel ?? MODEL_CHOICE_DEFAULT_OPTION,
    },
    ...choice.choices.map((entry) => {
      const note = badgeOf(entry);
      return {
        id: entry.id,
        label: entry.name,
        ...(note === undefined ? {} : { note }),
        disabled: !entry.available && entry.id !== choice.value,
      };
    }),
  ];
  return (
    <>
      <div data-field="provider" className="flex flex-col gap-2">
        <FieldLabel>Provider</FieldLabel>
        <Select value="managed">
          <SelectTrigger className="w-full" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="managed">{MODEL_CHOICE_PROVIDER}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {choice.choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {MODEL_CHOICE_NONE_OFFERED}
        </p>
      ) : (
        <ModelSelect
          name={fieldName}
          label="Model"
          value={choice.value ?? DEFAULT_OPTION}
          options={options}
          onChange={(id) => choice.onChange(id === DEFAULT_OPTION ? null : id)}
          error={choice.error}
          disabled={disabled}
        />
      )}
      {choice.choices.some(
        (entry) => entry.reason === "CATALOG_ENTRY_NOT_ALLOWED",
      ) ? (
        <p className="text-sm text-muted-foreground">
          Some options are not part of your plan.{" "}
          <Link
            href={workspacePath(workspaceSlug, "/settings/plan")}
            className="font-semibold underline underline-offset-4"
          >
            Manage plan
          </Link>
        </p>
      ) : null}
      {chosenUnavailable ? (
        // Static text, not a live region: it is true from the moment the page loads.
        <div
          className={alertVariants({ variant: "warning" })}
          data-choice-unavailable=""
        >
          <p className="col-start-1 [grid-column:1/-1]">
            {MODEL_CHOICE_CHOSEN_UNAVAILABLE}
          </p>
        </div>
      ) : null}
    </>
  );
}

export function LlmFieldset({
  workspaceSlug,
  disabled,
  own,
  managed,
  managedFieldName,
  catalogApi,
}: {
  workspaceSlug: string;
  disabled: boolean;
  /** Exactly one of `own` and `managed` is given. */
  own?: OwnLlmChoice;
  managed?: ManagedLlmChoice;
  /** The setting a managed choice edits, for the `data-field` of its dropdown. */
  managedFieldName?: string;
  /** Only tests pass this. */
  catalogApi?: CatalogModelsApi;
}) {
  return (
    <SettingsCard title="LLM" disabled={disabled}>
      {own !== undefined ? (
        <OwnKeyChoice
          workspaceSlug={workspaceSlug}
          choice={own}
          disabled={disabled}
          catalogApi={catalogApi}
        />
      ) : null}
      {managed !== undefined ? (
        <ManagedChoice
          workspaceSlug={workspaceSlug}
          choice={managed}
          disabled={disabled}
          fieldName={managedFieldName ?? "catalogEntryDynamic"}
        />
      ) : null}
    </SettingsCard>
  );
}
