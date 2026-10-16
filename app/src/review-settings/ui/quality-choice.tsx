// SPDX-License-Identifier: Apache-2.0

"use client";
// The quality choice of a workspace that reviews on the operator's key (#283): Low, Medium or High instead of a model.
// Each level is described by speed and depth only (`src/copy/model-quality.ts`). A level that has no model for the kind
// of review in force is shown as not available, without saying why; the one in force stays selectable so the choice
// never silently changes.
import { useId } from "react";
import { Alert } from "../../components/ui/alert.tsx";
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
  QUALITY_CHOSEN_UNAVAILABLE,
  QUALITY_HEADING,
  QUALITY_HINT,
  QUALITY_LEVELS,
  QUALITY_UNAVAILABLE_BADGE,
} from "../../copy/model-quality.ts";
import { cn } from "../../lib/utils.ts";
import {
  isModelTier,
  TIER_REVIEW_KINDS,
  type ModelTier,
  type TierAvailability,
} from "../../model-tiers/tiers.ts";
import type { ProjectReviewKind } from "../settings.ts";
import { Origin, type SettingsOrigin } from "./settings-fields.tsx";

/**
 * Whether a level can be used: for a project, it needs a model for the kind of review the project has; for the
 * workspace defaults, which every kind inherits, it needs one for every kind. `null` availability (not known) counts
 * as available, so a form never blocks a choice on a missing answer.
 */
export function tierIsAvailable(
  availability: TierAvailability | null,
  tier: ModelTier,
  kind: ProjectReviewKind | "every",
): boolean {
  if (availability === null) return true;
  const kinds = kind === "every" ? TIER_REVIEW_KINDS : [kind];
  return kinds.every((candidate) => availability[tier][candidate]);
}

export function QualityChoice({
  value,
  availability,
  kind,
  origin,
  error,
  onChange,
}: {
  value: ModelTier;
  availability: TierAvailability | null;
  /** The kind of review the choice is for; `every` on the workspace defaults. */
  kind: ProjectReviewKind | "every";
  origin: SettingsOrigin;
  error?: string | undefined;
  onChange: (tier: ModelTier) => void;
}) {
  const ids = useId();
  const errorId = `${ids}-error`;
  const chosenUnavailable = !tierIsAvailable(availability, value, kind);
  return (
    <div data-field="modelTier" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldTitle id={`${ids}-label`}>{QUALITY_HEADING}</FieldTitle>
        <Origin origin={origin} />
      </div>
      <FieldDescription id={`${ids}-hint`}>{QUALITY_HINT}</FieldDescription>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (isModelTier(next)) onChange(next);
        }}
        aria-labelledby={`${ids}-label`}
        aria-describedby={
          error === undefined ? `${ids}-hint` : `${ids}-hint ${errorId}`
        }
        aria-invalid={error !== undefined}
        className="gap-2"
      >
        {QUALITY_LEVELS.map((level) => {
          const optionId = `${ids}-${level.tier}`;
          const hintId = `${optionId}-hint`;
          const selected = level.tier === value;
          const available = tierIsAvailable(availability, level.tier, kind);
          return (
            <div
              key={level.tier}
              data-level={level.tier}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card transition-colors",
                "focus-within:ring-2 focus-within:ring-ring/50 hover:border-ring",
                selected && "border-primary bg-accent",
                !available && !selected && "opacity-70",
              )}
            >
              <FieldLabel
                htmlFor={optionId}
                className="flex min-h-11 w-full cursor-pointer items-start gap-3 p-4 pb-1"
              >
                <RadioGroupItem
                  value={level.tier}
                  id={optionId}
                  disabled={!available && !selected}
                  aria-describedby={hintId}
                  className="mt-0.5"
                />
                <span className="font-medium text-foreground">
                  {level.label}
                </span>
                {available ? null : (
                  <Badge variant="neutral">{QUALITY_UNAVAILABLE_BADGE}</Badge>
                )}
              </FieldLabel>
              <div id={hintId} className="pr-4 pb-4 pl-11">
                <FieldDescription>{level.description}</FieldDescription>
              </div>
            </div>
          );
        })}
      </RadioGroup>
      {chosenUnavailable ? (
        <Alert variant="warning" role="status" data-quality-unavailable="">
          {QUALITY_CHOSEN_UNAVAILABLE}
        </Alert>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
