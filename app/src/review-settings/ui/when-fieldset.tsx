// SPDX-License-Identifier: Apache-2.0

"use client";
// The "When to review" card of the review settings form (#174): the automatic triggers (a pull request
// opened, reopened or marked ready, and new commits) and the comment commands people may use. A
// review is started by hand on the review page; the command that page runs is the one chosen here.
import { REVIEW_COMMANDS } from "../../integrations/types.ts";
import {
  SettingsCard,
  SettingsCheckboxField,
  SettingsCommandsField,
  settingsOrigin,
  type SettingsFieldsetProps,
} from "./settings-fields.tsx";

export function WhenFieldset({
  model,
  state,
  errors,
  disabled,
  handlers,
}: SettingsFieldsetProps) {
  const origin = (
    name: "autoReviewOnOpen" | "autoReviewOnPush" | "allowedCommands",
    label: string,
  ) =>
    settingsOrigin({
      model,
      state,
      name,
      label,
      onReset: () => handlers.reset(name),
    });
  return (
    <SettingsCard title="When to review" disabled={disabled}>
      <SettingsCheckboxField
        name="autoReviewOnOpen"
        label="Review when a pull request is opened, reopened or marked ready"
        hint="Draft pull requests wait until they are ready."
        error={errors.autoReviewOnOpen}
        origin={origin(
          "autoReviewOnOpen",
          "Review when a pull request is opened, reopened or marked ready",
        )}
        checked={state.values.autoReviewOnOpen}
        onChange={(checked) => handlers.setBoolean("autoReviewOnOpen", checked)}
      />
      <SettingsCheckboxField
        name="autoReviewOnPush"
        label="Review again when commits are pushed"
        hint="A short pause lets several pushes count as one."
        error={errors.autoReviewOnPush}
        origin={origin(
          "autoReviewOnPush",
          "Review again when commits are pushed",
        )}
        checked={state.values.autoReviewOnPush}
        onChange={(checked) => handlers.setBoolean("autoReviewOnPush", checked)}
      />
      <SettingsCommandsField
        name="allowedCommands"
        label="Comment commands people may use"
        error={errors.allowedCommands}
        origin={origin("allowedCommands", "comment commands")}
        commands={REVIEW_COMMANDS}
        selected={state.values.allowedCommands}
        onToggle={(command, allowed) => handlers.setCommand(command, allowed)}
      />
    </SettingsCard>
  );
}
