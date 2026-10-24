// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Review kind" card of a project's settings form (#200): exactly one of Dynamic Review and Diff
// Review, and, while Dynamic Review is chosen, its review skill. Its provider and model are chosen in the LLM section
// (#656). The card never implies that Dynamic Review works while the instance has not enabled it (#195 gate): the
// option says so and choosing it shows what happens to the runs. Switching is confirmed by the form when it is saved.
import { useId } from "react";
import { Alert, alertVariants } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { FieldDescription, FieldLabel } from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils.ts";
import { KIND_NAMES } from "../kind-names.ts";
import type { ProjectDynamicView } from "../service.ts";
import type { ProjectReviewKind } from "../settings.ts";
import type { DynamicFormValues } from "./dynamic-form-state.ts";
import { SettingsCard } from "./settings-fields.tsx";
import { SkillEditor } from "./skill-editor.tsx";

const KIND_HINTS: Record<ProjectReviewKind, string> = {
  dynamic: "An agent explores the repository around the change.",
  diff: "Reviews the changes of the pull request.",
};

export const GATE_OFF_BADGE = "Not enabled yet.";
export const GATE_OFF_WARNING =
  "Dynamic Review is not enabled yet. Reviews of this project fail until a code-review.com admin turns it on.";
const KINDS: readonly ProjectReviewKind[] = ["dynamic", "diff"];

function isKind(value: string): value is ProjectReviewKind {
  return KINDS.some((kind) => kind === value);
}

export type ReviewKindHandlers = {
  setKind: (kind: ProjectReviewKind) => void;
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
}: {
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
                <span className="font-semibold text-foreground">
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
        <SkillEditor
          view={view}
          values={values}
          error={errors.reviewSkill}
          onEdit={handlers.editSkill}
          onChange={handlers.setSkill}
          onReset={handlers.resetSkill}
        />
      ) : null}

      {kindError !== null ? (
        <Alert variant="destructive" tabIndex={-1} data-kind-error="">
          {kindError}
        </Alert>
      ) : null}
    </SettingsCard>
  );
}
