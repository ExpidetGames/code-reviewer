// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Review" card of the review settings form (#174): how many findings one review may raise,
// whether a large pull request is reviewed in chunks, whether every finding is also posted inline,
// and the free-text project rules added to every review prompt.
import { REVIEW_SETTING_LIMITS, type ProjectReviewKind } from "../settings.ts";
import {
  SettingsCard,
  SettingsCheckboxField,
  SettingsTextareaField,
  SettingsTextField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";

export function ReviewFieldset({
  model,
  state,
  errors,
  disabled,
  handlers,
  kind = "diff",
}: SettingsFieldsetProps & {
  /**
   * The review kind selected in the form (#200). Chunking, inline comments and the project rules only
   * belong to the PR-Agent review, so an agent review does not show them; their values stay in the form.
   */
  kind?: ProjectReviewKind;
}) {
  const origin = (
    name:
      | "maxFindings"
      | "largePrChunking"
      | "inlineKeyIssues"
      | "extraInstructions",
    label: string,
  ) =>
    settingsOrigin({
      model,
      state,
      name,
      label,
      onReset: () => handlers.reset(name),
    });
  const instructionsLength = state.values.extraInstructions.length;
  return (
    <SettingsCard title="Review options" disabled={disabled}>
      <SettingsTextField
        name="maxFindings"
        label="Most findings per review"
        hint={`${String(REVIEW_SETTING_LIMITS.maxFindings.min)} to ${String(REVIEW_SETTING_LIMITS.maxFindings.max)}.`}
        error={errors.maxFindings}
        origin={origin("maxFindings", "Most findings per review")}
        value={state.values.maxFindings}
        onChange={(value) => handlers.setText("maxFindings", value)}
        inputMode="numeric"
      />
      {kind === "dynamic" ? null : (
        <>
          <SettingsCheckboxField
            name="largePrChunking"
            label="Review a large pull request in chunks"
            hint="Otherwise files that do not fit the token budget are left out."
            error={errors.largePrChunking}
            origin={origin(
              "largePrChunking",
              "Review a large pull request in chunks",
            )}
            checked={state.values.largePrChunking}
            onChange={(checked) =>
              handlers.setBoolean("largePrChunking", checked)
            }
          />
          <SettingsCheckboxField
            name="inlineKeyIssues"
            label="Also post every finding as an inline comment"
            hint="On the line the finding is about."
            error={errors.inlineKeyIssues}
            origin={origin(
              "inlineKeyIssues",
              "Also post every finding as an inline comment",
            )}
            checked={state.values.inlineKeyIssues}
            onChange={(checked) =>
              handlers.setBoolean("inlineKeyIssues", checked)
            }
          />
          <SettingsTextareaField
            name="extraInstructions"
            label="Project rules"
            hint={`Free text added to every review prompt (${instructionsLength.toLocaleString("en-US")} of ${REVIEW_SETTING_LIMITS.extraInstructionsMaxChars.toLocaleString("en-US")} characters).`}
            error={errors.extraInstructions}
            origin={origin("extraInstructions", "Project rules")}
            value={state.values.extraInstructions}
            onChange={(value) => handlers.setText("extraInstructions", value)}
            rows={6}
          />
        </>
      )}
    </SettingsCard>
  );
}
