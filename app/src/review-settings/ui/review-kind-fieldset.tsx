// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Review kind" card of a project's settings form (#200): exactly one of Diff Review and Dynamic
// Review, and, while Dynamic Review is chosen, its provider, model and review skill (or, for a workspace on the
// operator's key, its catalog choice). The card never implies that
// Dynamic Review works while the instance has not enabled it (#195 gate): the option says so and
// choosing it shows what happens to the runs. Switching is confirmed by the form when it is saved.
import { useId, type ReactNode } from "react";
import { Alert, alertVariants } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { FieldDescription, FieldLabel } from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils.ts";
import { ProviderSelect, type ProviderOption } from "./provider-select.tsx";
import { KIND_NAMES } from "../kind-names.ts";
import type { ProjectDynamicView } from "../service.ts";
import type { ProjectReviewKind } from "../settings.ts";
import type { DynamicFormValues } from "./dynamic-form-state.ts";
import {
  RESET_LABEL,
  SettingsCard,
  SettingsTextField,
  type SettingsOrigin,
} from "./settings-fields.tsx";
import { SkillEditor } from "./skill-editor.tsx";

const KIND_HINTS: Record<ProjectReviewKind, string> = {
  diff: "Reviews the changes of the pull request with PR-Agent.",
  dynamic: "A read-only agent explores the repository around the change.",
};

export const GATE_OFF_BADGE = "Not enabled on this instance yet.";
export const GATE_OFF_WARNING =
  "Dynamic Review is not enabled on this instance yet. Reviews of this project fail until an instance admin turns it on.";
export const NO_DYNAMIC_ESTIMATE =
  "No cost estimate for Dynamic Review yet. The estimate of Diff Review does not apply to an agent run.";

const KINDS: readonly ProjectReviewKind[] = ["diff", "dynamic"];

function isKind(value: string): value is ProjectReviewKind {
  return KINDS.some((kind) => kind === value);
}

export type ReviewKindHandlers = {
  setKind: (kind: ProjectReviewKind) => void;
  setModel: (text: string) => void;
  resetModel: () => void;
  setProvider: (provider: string) => void;
  resetProvider: () => void;
  editSkill: () => void;
  setSkill: (text: string) => void;
  resetSkill: () => void;
};

export function ReviewKindFieldset({
  view,
  values,
  errors,
  disabled,
  dynamicReviewEnabled,
  hiddenProblem,
  kindError,
  handlers,
  choice,
  workspaceSlug,
  providers,
  datalistId,
  suggestedModels,
}: {
  /**
   * The catalog choice of a workspace on the operator's key (#283, #433): it takes the place of the Dynamic provider
   * and model fields.
   */
  choice?: ReactNode;
  workspaceSlug: string;
  /** The registered providers, with whether a key is stored for each. */
  providers: readonly ProviderOption[];
  /** The id of the `<datalist>` of the known model names of the Dynamic provider, rendered by the container. */
  datalistId: string;
  /** The models of the Dynamic provider that can serve a Dynamic Review, to pick from under the field (#532). */
  suggestedModels: readonly string[];
  view: ProjectDynamicView;
  values: DynamicFormValues;
  errors: Partial<Record<string, string>>;
  disabled: boolean;
  /** Whether the instance has turned Dynamic Review on (the #195 gate). */
  dynamicReviewEnabled: boolean;
  /** The kind whose settings have a problem the selected kind does not show, or null. */
  hiddenProblem: ProjectReviewKind | null;
  /** The message of a request of this card that failed after another one was saved. */
  kindError: string | null;
  handlers: ReviewKindHandlers;
}) {
  const ids = useId();
  const dynamic = values.reviewKind === "dynamic";
  const kindErrorId = `${ids}-kind-error`;
  // The model follows the same "Reset to default" affordance as every other field: it appears while
  // the value is not the built-in default, puts the default back, and the save clears the override.
  const modelOrigin: SettingsOrigin = {
    source:
      view.sources.dynamicModel === "project"
        ? "Set for this project"
        : "Built-in value",
    resetLabel:
      values.dynamicModel.trim() === view.defaults.dynamicModel
        ? null
        : RESET_LABEL,
    resetAriaLabel: "Reset to default for Dynamic Review model",
    onReset: handlers.resetModel,
  };
  const providerOrigin: SettingsOrigin = {
    source:
      view.sources.dynamicProvider === "project" ||
      values.dynamicProvider !== (view.defaults.dynamicProvider ?? "")
        ? "Set for this project"
        : "Built-in value",
    resetLabel:
      values.dynamicProvider === (view.defaults.dynamicProvider ?? "")
        ? null
        : RESET_LABEL,
    resetAriaLabel: "Reset to default for Dynamic Review provider",
    onReset: handlers.resetProvider,
  };
  return (
    <SettingsCard title="Review kind" disabled={disabled}>
      <RadioGroup
        value={values.reviewKind}
        onValueChange={(value) => {
          if (isKind(value)) handlers.setKind(value);
        }}
        aria-label="Review kind"
        aria-describedby={
          errors.reviewKind === undefined ? undefined : kindErrorId
        }
        className="gap-2"
      >
        {KINDS.map((kind) => {
          const optionId = `${ids}-${kind}`;
          const hintId = `${optionId}-hint`;
          const selected = kind === values.reviewKind;
          return (
            <div
              key={kind}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card transition-colors",
                "focus-within:ring-2 focus-within:ring-ring/50 hover:border-ring",
                selected && "border-primary bg-accent",
              )}
            >
              <FieldLabel
                htmlFor={optionId}
                className="flex min-h-11 w-full cursor-pointer items-start gap-3 p-4 pb-1"
              >
                <RadioGroupItem
                  value={kind}
                  id={optionId}
                  aria-describedby={
                    errors.reviewKind === undefined
                      ? hintId
                      : `${hintId} ${kindErrorId}`
                  }
                  aria-invalid={errors.reviewKind !== undefined}
                  className="mt-0.5"
                />
                <span className="font-medium text-foreground">
                  {KIND_NAMES[kind]}
                </span>
              </FieldLabel>
              <div
                id={hintId}
                className="flex flex-wrap items-center gap-2 pr-4 pb-4 pl-11"
              >
                <FieldDescription>{KIND_HINTS[kind]}</FieldDescription>
                {kind === "dynamic" && !dynamicReviewEnabled ? (
                  <Badge variant="warning">{GATE_OFF_BADGE}</Badge>
                ) : null}
              </div>
            </div>
          );
        })}
      </RadioGroup>

      {errors.reviewKind !== undefined ? (
        <p id={kindErrorId} className="text-sm text-destructive">
          {errors.reviewKind}
        </p>
      ) : null}

      {dynamic && !dynamicReviewEnabled ? (
        // Static text, not a live region: it is true from the moment the page loads.
        <div className={alertVariants({ variant: "warning" })}>
          <p className="col-start-1 [grid-column:1/-1]">{GATE_OFF_WARNING}</p>
        </div>
      ) : null}

      {hiddenProblem !== null ? (
        <Alert
          variant="destructive"
          tabIndex={-1}
          data-hidden-problem=""
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          A {KIND_NAMES[hiddenProblem]} setting is not valid. Choose{" "}
          {KIND_NAMES[hiddenProblem]} to see it and fix it.
        </Alert>
      ) : null}

      {dynamic ? (
        <>
          {choice !== undefined ? (
            choice
          ) : (
            <>
              <ProviderSelect
                workspaceSlug={workspaceSlug}
                name="dynamicProvider"
                label="Dynamic Review provider"
                value={values.dynamicProvider}
                options={providers}
                origin={providerOrigin}
                error={errors.dynamicProvider}
                onChange={handlers.setProvider}
              />
              <SettingsTextField
                name="dynamicModel"
                label="Dynamic Review model"
                hint={`The model the agent uses. Type the name of any model your provider serves; the default is ${view.defaults.dynamicModel ?? ""}.`}
                error={errors.dynamicModel}
                origin={modelOrigin}
                value={values.dynamicModel}
                onChange={handlers.setModel}
                list={datalistId}
                suggestions={{
                  label: "Suggested Dynamic Review models",
                  models: suggestedModels,
                }}
              />
            </>
          )}
          <SkillEditor
            view={view}
            values={values}
            error={errors.reviewSkill}
            onEdit={handlers.editSkill}
            onChange={handlers.setSkill}
            onReset={handlers.resetSkill}
          />
          <p className="text-sm text-muted-foreground">{NO_DYNAMIC_ESTIMATE}</p>
        </>
      ) : null}

      {kindError !== null ? (
        <Alert variant="destructive" tabIndex={-1} data-kind-error="">
          {kindError}
        </Alert>
      ) : null}
    </SettingsCard>
  );
}
