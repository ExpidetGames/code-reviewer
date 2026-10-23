// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Limits" section of the settings form (#656): what one review may cost, and (for a Diff Review) how much of a pull
// request the model reads. An empty field is not "no limit" on a project: it follows the workspace default, and the field
// says which one that is. The cost limit is roughly the most one review may cost; it never lifts the limit of the instance
// (the cost guard of Dynamic Review, #540).
import { REVIEW_SETTING_LIMITS } from "../settings.ts";
import type { ReviewCostGuard } from "../cost.ts";
import { CostSummary } from "./cost-summary.tsx";
import {
  SettingsCard,
  SettingsTextField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";

export function tokenBudgetHint(): string {
  const { min, max } = REVIEW_SETTING_LIMITS.maxTokens;
  return `How much of a pull request the model reads in one go. Between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")} tokens.`;
}

/** The workspace default as a sentence part: "$2.00" or "no limit". */
export function describeCostLimit(cents: number | null | undefined): string {
  return cents === null || cents === undefined
    ? "no limit"
    : `$${(cents / 100).toFixed(2)}`;
}

/**
 * What the cost limit means, by whose key pays, and what an empty field does. No rate and no markup is named: on the
 * operator's key the limit is held to our price, on the workspace's own key to the model cost plus our infrastructure fee.
 */
export function costLimitHint(
  mode: "project" | "global",
  inherited: number | null | undefined,
  managed: boolean,
): string {
  const start = managed
    ? "Roughly the most one review may cost, at our price."
    : "Roughly the most one review may cost: the model cost at your provider plus our infrastructure fee.";
  return mode === "project"
    ? `${start} Leave empty to use the workspace default (${describeCostLimit(inherited)}).`
    : `${start} Leave empty for no limit of your own; the limit of this instance still applies.`;
}

export function LimitsFieldset({
  model,
  state,
  errors,
  disabled,
  handlers,
  cost,
  showTokenBudget,
}: SettingsFieldsetProps & {
  /** The estimate of a Diff Review on the workspace's own model; null when there is none. */
  cost: ReviewCostGuard | null;
  /** The token budget belongs to a Diff Review only: a Dynamic Review is bound by its own window. */
  showTokenBudget: boolean;
}) {
  const origin = (name: "maxCostCents" | "maxTokens", label: string) =>
    settingsOrigin({
      model,
      state,
      name,
      label,
      onReset: () => handlers.reset(name),
    });
  return (
    <SettingsCard title="Limits" disabled={disabled}>
      <SettingsTextField
        name="maxCostCents"
        label="Cost limit per review (USD)"
        hint={costLimitHint(
          model.mode,
          model.inherited.maxCostCents,
          model.managed,
        )}
        error={errors.maxCostCents}
        origin={origin("maxCostCents", "Cost limit per review")}
        value={state.values.maxCostCents}
        onChange={(value) => handlers.setText("maxCostCents", value)}
        inputMode="decimal"
        placeholder={
          model.mode === "project"
            ? describeCostLimit(model.inherited.maxCostCents)
            : "No limit"
        }
      />
      {showTokenBudget ? (
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
      ) : null}
      {showTokenBudget ? <CostSummary cost={cost} /> : null}
    </SettingsCard>
  );
}
