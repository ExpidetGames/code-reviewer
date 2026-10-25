// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Limits" section of the settings form (#656, #666, #689): the cost a review may reach before it stops. The most it can be
// is the maximum per review that code-review.com sets, which the field shows ("Max $1.00") and which an empty field means. An
// empty field on a project follows the workspace default, and the field says which one that is. The runner enforces the cost
// limit (a Dynamic Review is wrapped up with the findings it has, a Diff Review sends no further request); no rate and no
// markup is named. There is no token budget: the app decides how much of a pull request the model reads.
import { costLimitUsdOf, type ReviewCostGuard } from "../cost.ts";
import { CostSummary } from "./cost-summary.tsx";
import { formatDollars } from "./messages.ts";
import {
  SettingsCard,
  SettingsTextField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";

/** A cost limit as a sentence part: "$2.00". */
export function describeCostLimit(cents: number): string {
  return `$${costLimitUsdOf({ maxCostCents: cents }).toFixed(2)}`;
}

/** What the empty field means and shows: up to the maximum, "Max $1.00". */
export function maxCostPlaceholder(maximumCents: number): string {
  return `Max ${formatDollars(maximumCents)}`;
}

/**
 * What the cost field does: a review stops when it reaches the amount, and never costs more than the maximum. A Diff Review
 * checks it between model requests (#666), so a single request can exceed it. An empty field is the workspace default, or up
 * to the maximum where there is none. A limit above the maximum is cut to it, and the field says so. No rate and no markup is
 * named.
 */
export function costLimitHint(
  mode: "project" | "global",
  inherited: number | null | undefined,
  maximumCents: number,
  options: { diff?: boolean; saved?: number | null } = {},
): string {
  const maximum = formatDollars(maximumCents);
  const note = options.diff
    ? " For a Diff Review the limit is checked between model requests, so a single request can exceed it."
    : "";
  const start = `A review stops when it reaches this amount, at most ${maximum}.${note}`;
  const capped =
    options.saved !== null &&
    options.saved !== undefined &&
    options.saved > maximumCents
      ? ` The saved limit of ${formatDollars(options.saved)} is above the maximum, so reviews stop at ${maximum}.`
      : "";
  if (mode === "global")
    return `${start}${capped} Leave empty for up to ${maximum}.`;
  if (inherited === null || inherited === undefined)
    return `${start}${capped} Leave empty for up to ${maximum}; the workspace sets no limit.`;
  return `${start}${capped} Leave empty to use the workspace default (${describeCostLimit(inherited)}).`;
}

export function LimitsFieldset({
  model,
  state,
  errors,
  disabled,
  handlers,
  cost,
  diff,
}: SettingsFieldsetProps & {
  /** The estimate of a Diff Review on the workspace's own model; null when there is none. */
  cost: ReviewCostGuard | null;
  /** The review kind is Diff Review: its limit is checked between requests, and the estimate is the one of a Diff Review. */
  diff: boolean;
}) {
  const maximumCents = model.operatorMaxCostCents;
  const inherited = model.inherited.maxCostCents;
  return (
    <SettingsCard title="Limits" disabled={disabled}>
      <SettingsTextField
        name="maxCostCents"
        label="Cost limit per review (USD)"
        hint={costLimitHint(model.mode, inherited, maximumCents, {
          diff,
          saved: model.effective.maxCostCents ?? null,
        })}
        error={errors.maxCostCents}
        origin={settingsOrigin({
          model,
          state,
          name: "maxCostCents",
          label: "Cost limit per review",
          onReset: () => handlers.reset("maxCostCents"),
        })}
        value={state.values.maxCostCents}
        onChange={(value) => handlers.setText("maxCostCents", value)}
        inputMode="decimal"
        placeholder={
          model.mode === "project" &&
          inherited !== null &&
          inherited !== undefined
            ? describeCostLimit(Math.min(inherited, maximumCents))
            : maxCostPlaceholder(maximumCents)
        }
      />
      {/* A workspace on the operator's key does not know the model, so there is no estimate for it to read. */}
      {diff && !model.managed ? <CostSummary cost={cost} /> : null}
    </SettingsCard>
  );
}
