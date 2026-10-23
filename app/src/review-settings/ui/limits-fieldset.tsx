// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Limits" section of the settings form (#656): the cost level a review is warned above, and (for a Diff Review) how
// much of a pull request the model reads. An empty field on a project follows the workspace default, and the field says
// which one that is. The cost value only warns for now; enforcing it is #666, and the copy changes with it.
import { REVIEW_SETTING_LIMITS } from "../settings.ts";
import { costLimitUsdOf, type ReviewCostGuard } from "../cost.ts";
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

/** The warning level as a sentence part: "$2.00". An empty default is the standard level of the estimate. */
export function describeCostLimit(cents: number | null | undefined): string {
  return `$${costLimitUsdOf({ maxCostCents: cents }).toFixed(2)}`;
}

/**
 * What the cost field does today: the estimate warns above it. Nothing is capped by it yet (that is #666), so the copy
 * says "warn" and the hint changes when the limit is enforced. No rate and no markup is named.
 */
export function costLimitHint(
  mode: "project" | "global",
  inherited: number | null | undefined,
): string {
  const start =
    "We warn you when a review is estimated to cost more than this.";
  return mode === "project"
    ? `${start} Leave empty to use the workspace default (${describeCostLimit(inherited)}).`
    : `${start} Leave empty for the standard level (${describeCostLimit(null)}).`;
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
        label="Cost warning per review (USD)"
        hint={costLimitHint(model.mode, model.inherited.maxCostCents)}
        error={errors.maxCostCents}
        origin={origin("maxCostCents", "Cost warning per review")}
        value={state.values.maxCostCents}
        onChange={(value) => handlers.setText("maxCostCents", value)}
        inputMode="decimal"
        placeholder={
          model.mode === "project"
            ? describeCostLimit(model.inherited.maxCostCents)
            : describeCostLimit(null)
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
