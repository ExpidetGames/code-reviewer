// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Model" card of the review settings form (#174): the provider and the model, the fallback model and the
// token budget, with the estimated cost of one review at the foot (the cost belongs next to the model it
// depends on, not at the end of the form). Every field shows where its value comes from and can be
// taken back to the layer below with "Reset to default". A workspace on the operator's key sees the catalog
// choice (or, on the workspace defaults, a note) in place of the provider and the model fields (#283, #433).
import type { ReactNode } from "react";
import { MODEL_CHOICE_HEADING } from "../../copy/model-choice.ts";
import type { ReviewCostGuard } from "../cost.ts";
import {
  SettingsCard,
  SettingsTextField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";
import { ProviderSelect, type ProviderOption } from "./provider-select.tsx";
import { CostSummary } from "./cost-summary.tsx";
import { REVIEW_SETTING_LIMITS } from "../settings.ts";
import { SUGGESTED_MODEL_PICK } from "./messages.ts";

/** The one sentence about the model, the fact people ask about most. */
export function modelHint(providerLabel: string): string {
  return `The AI model that writes the review. Pick one from the list or type the name of any model ${providerLabel} offers. Smaller models cost less per review, larger ones usually review more thoroughly.`;
}

// The settings accept a fallback model, but the app does not send it to the runner yet (lead
// decision for the MVP, src/review-settings/README.md), so the form says so instead of promising it.
export const FALLBACK_MODEL_HINT =
  "Stored but not used yet: reviews do not switch to this model when the main model fails. Leave empty for none.";

export function tokenBudgetHint(): string {
  const { min, max } = REVIEW_SETTING_LIMITS.maxTokens;
  return `How much of a pull request the model can read in one go. A token is about three quarters of a word, so a bigger budget lets it see more of a large change, but costs more. Between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}.`;
}

export function ModelFieldset({
  model,
  state,
  errors,
  disabled,
  handlers,
  cost,
  workspaceSlug,
  providers,
  datalistId,
  suggestedModels,
  choice,
}: SettingsFieldsetProps & {
  /**
   * The catalog choice of a workspace on the operator's key (#283, #433). It takes the place of the provider, the
   * model, the fallback model and the cost estimate; the token budget stays.
   */
  choice?: ReactNode;
  cost: ReviewCostGuard | null;
  workspaceSlug: string;
  /** The registered providers, with whether a key is stored for each. */
  providers: readonly ProviderOption[];
  /** The id of the `<datalist>` of the known model names of the chosen provider, rendered by the container. */
  datalistId: string;
  /** The models of the chosen provider to pick from under the model fields (#532). */
  suggestedModels: readonly string[];
}) {
  const origin = (
    name: "provider" | "model" | "fallbackModel" | "maxTokens",
    label: string,
  ) =>
    settingsOrigin({
      model,
      state,
      name,
      label,
      onReset: () => handlers.reset(name),
    });
  const budget = (
    <SettingsTextField
      name="maxTokens"
      label="Token budget"
      hint={tokenBudgetHint()}
      error={errors.maxTokens}
      origin={origin("maxTokens", "Token budget")}
      value={state.values.maxTokens}
      onChange={(value) => handlers.setText("maxTokens", value)}
      inputMode="numeric"
    />
  );
  if (choice !== undefined)
    return (
      <SettingsCard title={MODEL_CHOICE_HEADING} disabled={disabled}>
        {choice}
        {budget}
      </SettingsCard>
    );
  const providerLabel =
    providers.find((option) => option.id === state.values.provider)?.label ??
    state.values.provider;
  return (
    <SettingsCard title="Model" disabled={disabled}>
      <ProviderSelect
        workspaceSlug={workspaceSlug}
        name="provider"
        label="Provider"
        value={state.values.provider}
        options={providers}
        origin={origin("provider", "Provider")}
        error={errors.provider}
        onChange={(value) => handlers.setText("provider", value)}
      />
      <SettingsTextField
        name="model"
        label="Model"
        hint={modelHint(providerLabel)}
        error={errors.model}
        origin={origin("model", "Model")}
        value={state.values.model}
        onChange={(value) => handlers.setText("model", value)}
        list={datalistId}
        suggestions={{
          label: SUGGESTED_MODEL_PICK.model,
          models: suggestedModels,
        }}
      />
      <SettingsTextField
        name="fallbackModel"
        label="Fallback model"
        hint={FALLBACK_MODEL_HINT}
        error={errors.fallbackModel}
        origin={origin("fallbackModel", "Fallback model")}
        value={state.values.fallbackModel}
        onChange={(value) => handlers.setText("fallbackModel", value)}
        list={datalistId}
        suggestions={{
          label: SUGGESTED_MODEL_PICK.fallbackModel,
          models: suggestedModels,
        }}
        placeholder="None"
      />
      {budget}
      <CostSummary cost={cost} />
    </SettingsCard>
  );
}
