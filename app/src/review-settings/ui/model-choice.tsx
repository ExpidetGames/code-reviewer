// SPDX-License-Identifier: Apache-2.0

"use client";
// The choice of a workspace that reviews on the operator's key (#283, #433): one entry of the catalog per kind of review
// instead of a model. Each entry is shown by the name and the description the operator wrote, in the order the view
// gives (`sort_order`), and nothing else: the view holds neither a provider nor a model. An entry the workspace's plan
// does not include is shown locked, with a link to the plan page (decision C4); an entry that was taken out of the
// catalog while the project still has it chosen says so (C5). The entry in force stays selectable even when it
// cannot be used, so the choice never changes silently, and a note says its reviews would not start.
import Link from "next/link";
import { useId } from "react";
import { alertVariants } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import {
  MODEL_CHOICE_CHOSEN_UNAVAILABLE,
  MODEL_CHOICE_DEFAULT_SOURCE,
  MODEL_CHOICE_HEADING,
  MODEL_CHOICE_HINT,
  MODEL_CHOICE_LOCKED_BADGE,
  MODEL_CHOICE_MANAGE_PLAN,
  MODEL_CHOICE_NONE_CHOSEN,
  MODEL_CHOICE_NONE_OFFERED,
  MODEL_CHOICE_PER_PROJECT_NOTE,
  MODEL_CHOICE_RETIRED_BADGE,
} from "../../copy/model-choice.ts";
import { cn } from "../../lib/utils.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { CatalogChoice } from "../catalog-selection.ts";
import { CATALOG_FIELD_OF_KIND, type ProjectReviewKind } from "../settings.ts";
import {
  Origin,
  RESET_LABEL,
  type SettingsOrigin,
} from "./settings-fields.tsx";

/** The origin line of the choice: set for this project, or the default of the instance (decision C3: no workspace default). */
export function modelChoiceOrigin(
  value: string | null,
  onReset: () => void,
): SettingsOrigin {
  return {
    source:
      value === null ? MODEL_CHOICE_DEFAULT_SOURCE : "Set for this project",
    resetLabel: value === null ? null : RESET_LABEL,
    resetAriaLabel: `${RESET_LABEL} for ${MODEL_CHOICE_HEADING}`,
    onReset,
  };
}

/** Instead of the choice on the workspace defaults, which hold none: it is made for each project. */
export function ModelChoiceNote() {
  return (
    <p className="text-sm text-muted-foreground">
      {MODEL_CHOICE_PER_PROJECT_NOTE}
    </p>
  );
}

function badgeOf(choice: CatalogChoice): string | null {
  if (choice.available) return null;
  return choice.reason === "CATALOG_ENTRY_NOT_RELEASED"
    ? MODEL_CHOICE_RETIRED_BADGE
    : MODEL_CHOICE_LOCKED_BADGE;
}

export function ModelChoice({
  workspaceSlug,
  kind,
  choices,
  value,
  error,
  onChange,
}: {
  workspaceSlug: string;
  /** The kind of review the choice is for. */
  kind: ProjectReviewKind;
  /** The entries that serve the kind, in the order they are shown. */
  choices: readonly CatalogChoice[];
  /** The id of the entry in force, or null: none, the default of the instance applies. */
  value: string | null;
  error?: string | undefined;
  /** `null` takes the choice back. */
  onChange: (id: string | null) => void;
}) {
  const ids = useId();
  const errorId = `${ids}-error`;
  // An entry the view does not list at all (it is gone) is as unusable as a locked one.
  const chosenUnavailable =
    value !== null &&
    choices.find((choice) => choice.id === value)?.available !== true;
  const planLink = workspacePath(workspaceSlug, "/settings/plan");
  return (
    <div
      data-field={CATALOG_FIELD_OF_KIND[kind]}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldTitle id={`${ids}-label`}>{MODEL_CHOICE_HEADING}</FieldTitle>
        <Origin origin={modelChoiceOrigin(value, () => onChange(null))} />
      </div>
      <FieldDescription id={`${ids}-hint`}>
        {MODEL_CHOICE_HINT}
      </FieldDescription>
      {choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {MODEL_CHOICE_NONE_OFFERED}
        </p>
      ) : (
        <RadioGroup
          value={value ?? ""}
          onValueChange={onChange}
          aria-labelledby={`${ids}-label`}
          aria-describedby={
            error === undefined ? `${ids}-hint` : `${ids}-hint ${errorId}`
          }
          aria-invalid={error !== undefined}
          className="gap-2"
        >
          {choices.map((choice) => {
            const optionId = `${ids}-${choice.id}`;
            const hintId = `${optionId}-hint`;
            const selected = choice.id === value;
            const badge = badgeOf(choice);
            return (
              <div
                key={choice.id}
                data-entry={choice.id}
                className={cn(
                  "flex flex-col rounded-lg border border-border bg-card transition-colors",
                  "focus-within:ring-2 focus-within:ring-ring/50 hover:border-ring",
                  selected && "border-primary bg-accent",
                  !choice.available && !selected && "opacity-70",
                )}
              >
                <FieldLabel
                  htmlFor={optionId}
                  className="flex min-h-11 w-full cursor-pointer items-start gap-3 p-4 pb-1"
                >
                  <RadioGroupItem
                    value={choice.id}
                    id={optionId}
                    disabled={!choice.available && !selected}
                    aria-describedby={hintId}
                    className="mt-0.5"
                  />
                  <span className="font-semibold text-foreground">
                    {choice.name}
                  </span>
                  {badge === null ? null : (
                    <Badge variant="neutral">{badge}</Badge>
                  )}
                </FieldLabel>
                <div
                  id={hintId}
                  className="flex flex-col items-start gap-1 pr-4 pb-4 pl-11"
                >
                  {choice.description === null ? null : (
                    <FieldDescription>{choice.description}</FieldDescription>
                  )}
                  {choice.reason === "CATALOG_ENTRY_NOT_ALLOWED" ? (
                    <Link
                      href={planLink}
                      className="text-sm font-semibold text-foreground"
                    >
                      {MODEL_CHOICE_MANAGE_PLAN}
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      )}
      {value === null && choices.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {MODEL_CHOICE_NONE_CHOSEN}
        </p>
      ) : null}
      {chosenUnavailable ? (
        // Static text, not a live region: it is true from the moment the page loads.
        <div
          className={alertVariants({ variant: "warning" })}
          data-choice-unavailable=""
        >
          <p className="col-start-1 [grid-column:1/-1]">
            {MODEL_CHOICE_CHOSEN_UNAVAILABLE}
          </p>
        </div>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
