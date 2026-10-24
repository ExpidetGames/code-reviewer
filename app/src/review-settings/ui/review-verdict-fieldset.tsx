// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Review verdict" card of a project's settings form (#405): whether code-review.com, after a successful
// review, also submits a pull request review as itself (Request changes while a blocking finding is open,
// Approve otherwise). One choice for both review kinds; what "blocking" means differs, and the card says so for
// the kind that is selected. Saved with the Review kind card (one project-only request). The text is short (#656):
// one line per choice and one note.
import { useId } from "react";
import { FieldDescription, FieldLabel } from "../../components/ui/field.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils.ts";
import {
  REVIEW_VERDICT_MODES,
  type ProjectReviewKind,
  type ReviewVerdictMode,
} from "../settings.ts";
import { SettingsCard } from "./settings-fields.tsx";

export const VERDICT_NAMES: Record<ReviewVerdictMode, string> = {
  off: "Off",
  blocking: "Blocking findings",
  any: "Any finding",
};

const VERDICT_HINTS: Record<ReviewVerdictMode, string> = {
  off: "No review on the pull request.",
  blocking: "Request changes while a blocking finding is open.",
  any: "Request changes while any finding is open.",
};

/** What "blocking" means for the selected review kind, in one short sentence. */
export const VERDICT_KIND_NOTES: Record<ProjectReviewKind, string> = {
  dynamic: "Blocking means a P0 finding.",
  diff: "A Diff Review has no severities, so Blocking findings posts nothing.",
};

export const VERDICT_COMMON_NOTE =
  "Posted as a pull request review by code-review.com after a complete review. Do not rely on it for branch protection.";

function isMode(value: string): value is ReviewVerdictMode {
  return REVIEW_VERDICT_MODES.some((mode) => mode === value);
}

export function ReviewVerdictFieldset({
  value,
  kind,
  defaultMode,
  error,
  disabled,
  onChange,
}: {
  value: ReviewVerdictMode;
  /** The review kind selected in the form: the note says what blocking means for it. */
  kind: ProjectReviewKind;
  defaultMode: ReviewVerdictMode;
  error: string | undefined;
  disabled: boolean;
  onChange: (mode: ReviewVerdictMode) => void;
}) {
  const ids = useId();
  const errorId = `${ids}-error`;
  return (
    <SettingsCard title="Review verdict" disabled={disabled}>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (isMode(next)) onChange(next);
        }}
        aria-label="Review verdict"
        aria-describedby={error === undefined ? undefined : errorId}
        className="gap-2"
      >
        {REVIEW_VERDICT_MODES.map((mode) => {
          const optionId = `${ids}-${mode}`;
          const hintId = `${optionId}-hint`;
          return (
            <div
              key={mode}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card transition-colors",
                "focus-within:ring-2 focus-within:ring-ring/50 hover:border-ring",
                mode === value && "border-primary bg-accent",
              )}
            >
              <FieldLabel
                htmlFor={optionId}
                className="flex min-h-11 w-full cursor-pointer items-start gap-3 p-4 pb-1"
              >
                <RadioGroupItem
                  value={mode}
                  id={optionId}
                  aria-describedby={
                    error === undefined ? hintId : `${hintId} ${errorId}`
                  }
                  aria-invalid={error !== undefined}
                  className="mt-0.5"
                />
                <span className="font-semibold text-foreground">
                  {VERDICT_NAMES[mode]}
                  {mode === defaultMode ? " (default)" : ""}
                </span>
              </FieldLabel>
              <div id={hintId} className="pr-4 pb-4 pl-11">
                <FieldDescription>{VERDICT_HINTS[mode]}</FieldDescription>
              </div>
            </div>
          );
        })}
      </RadioGroup>
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {VERDICT_KIND_NOTES[kind]} {VERDICT_COMMON_NOTE}
      </p>
    </SettingsCard>
  );
}
