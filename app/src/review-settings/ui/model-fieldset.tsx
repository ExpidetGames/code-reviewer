// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Model" card of the review settings form (#174): the model, the fallback model and the token
// budget, with the estimated cost of one review at the foot (the cost belongs next to the model it
// depends on, not at the end of the form). Every field shows where its value comes from and can be
// taken back to the layer below with "Reset to default".
import type { ReactNode } from "react";
import { QUALITY_HEADING } from "../../copy/model-quality.ts";
import { DEFAULT_LLM_PROVIDER_LABEL } from "../../llm/providers/index.ts";
import type { ReviewCostGuard } from "../cost.ts";
import {
  SettingsCard,
  SettingsTextField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";
import { CostSummary } from "./cost-summary.tsx";
import { REVIEW_SETTING_LIMITS } from "../settings.ts";

/** The one sentence about the model, the fact people ask about most. */
export const MODEL_HINT = `The AI model that writes the review. Pick one from the list or type the name of any model ${DEFAULT_LLM_PROVIDER_LABEL} offers. Smaller models cost less per review, larger ones usually review more thoroughly.`;

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
  datalistId,
  quality,
}: SettingsFieldsetProps & {
  /**
   * The quality choice of a workspace on the operator's key (#283). It takes the place of the model, the fallback
   * model and the cost estimate; the token budget stays.
   */
  quality?: ReactNode;
  cost: ReviewCostGuard | null;
  /** The id of the `<datalist>` of known model names, rendered by the container. */
  datalistId: string;
}) {
  const origin = (
    name: "model" | "fallbackModel" | "maxTokens",
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
  if (quality !== undefined)
    return (
      <SettingsCard title={QUALITY_HEADING} disabled={disabled}>
        {quality}
        {budget}
      </SettingsCard>
    );
  return (
    <SettingsCard title="Model" disabled={disabled}>
      <SettingsTextField
        name="model"
        label="Model"
        hint={MODEL_HINT}
        error={errors.model}
        origin={origin("model", "Model")}
        value={state.values.model}
        onChange={(value) => handlers.setText("model", value)}
        list={datalistId}
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
        placeholder="None"
      />
      {budget}
      <CostSummary cost={cost} />
    </SettingsCard>
  );
}
