// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Limits" section of the settings form (#656, #666): the cost a review may reach before it stops, and (for a Diff Review) how
// much of a pull request the model reads. An empty field on a project follows the workspace default, and the field says which
// one that is. The runner enforces the cost limit (a Dynamic Review is wrapped up with the findings it has, a Diff Review sends
// no further request); no rate and no markup is named.
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

/** A cost limit as a sentence part: "$2.00". */
export function describeCostLimit(cents: number): string {
  return `$${costLimitUsdOf({ maxCostCents: cents }).toFixed(2)}`;
}

const NO_LIMIT = "No limit";

/**
 * What the cost field does: a review stops when it reaches the amount. A Diff Review checks it between model requests (#666),
 * so a single request can exceed it. The instance may enforce a lower limit of its own, which the field does not show. An
 * empty field is the workspace default, or no limit of the customer's own where there is none. No rate and no markup is named.
 */
export function costLimitHint(
  mode: "project" | "global",
  inherited: number | null | undefined,
  diff = false,
): string {
  const start = "A review stops when it reaches this amount.";
  const note = diff
    ? " For a Diff Review the limit is checked between model requests, so a single request can exceed it."
    : "";
  const instance = " The instance may enforce a lower limit.";
  if (mode === "global")
    return `${start}${note}${instance} Leave empty for no limit of your own.`;
  if (inherited === null || inherited === undefined)
    return `${start}${note}${instance} Leave empty for no limit of your own; the workspace sets none.`;
  return `${start}${note}${instance} Leave empty to use the workspace default (${describeCostLimit(inherited)}).`;
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
          showTokenBudget,
        )}
        error={errors.maxCostCents}
        origin={origin("maxCostCents", "Cost limit per review")}
        value={state.values.maxCostCents}
        onChange={(value) => handlers.setText("maxCostCents", value)}
        inputMode="decimal"
        placeholder={
          model.mode === "project" &&
          model.inherited.maxCostCents !== null &&
          model.inherited.maxCostCents !== undefined
            ? describeCostLimit(model.inherited.maxCostCents)
            : NO_LIMIT
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
      {/* A workspace on the operator's key does not know the model, so there is no estimate for it to read. */}
      {showTokenBudget && !model.managed ? <CostSummary cost={cost} /> : null}
    </SettingsCard>
  );
}
