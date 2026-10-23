// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Trigger" section of the review settings form (#174, #656): when the reviewer starts: the automatic triggers (a
// pull request opened, reopened or marked ready, and new commits) and the comment commands people may use.
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
    <SettingsCard title="Trigger" disabled={disabled}>
      <SettingsCheckboxField
        name="autoReviewOnOpen"
        label="When a pull request is opened or ready"
        hint="Drafts wait until they are ready."
        error={errors.autoReviewOnOpen}
        origin={origin(
          "autoReviewOnOpen",
          "When a pull request is opened or ready",
        )}
        checked={state.values.autoReviewOnOpen}
        onChange={(checked) => handlers.setBoolean("autoReviewOnOpen", checked)}
      />
      <SettingsCheckboxField
        name="autoReviewOnPush"
        label="When commits are pushed"
        hint="A short pause lets several pushes count as one."
        error={errors.autoReviewOnPush}
        origin={origin("autoReviewOnPush", "When commits are pushed")}
        checked={state.values.autoReviewOnPush}
        onChange={(checked) => handlers.setBoolean("autoReviewOnPush", checked)}
      />
      <SettingsCommandsField
        name="allowedCommands"
        label="Comment commands"
        error={errors.allowedCommands}
        origin={origin("allowedCommands", "comment commands")}
        commands={REVIEW_COMMANDS}
        selected={state.values.allowedCommands}
        onToggle={(command, allowed) => handlers.setCommand(command, allowed)}
      />
    </SettingsCard>
  );
}
