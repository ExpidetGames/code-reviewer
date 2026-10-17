// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Review verdict" card of a project's settings form (#405): whether Code Reviewer, after a successful
// review, also submits a pull request review as itself (Request changes while a blocking finding is open,
// Approve otherwise). One choice for both review kinds; what "blocking" means differs, and the card says so for
// the kind that is selected. Saved with the Review kind card (one project-only request).
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
  blocking: "Blocking findings only",
  any: "Any finding",
};

const VERDICT_HINTS: Record<ReviewVerdictMode, string> = {
  off: "Code Reviewer never submits a pull request review. The check run still shows the result.",
  blocking:
    "Requests changes while a blocking finding is open, and approves otherwise.",
  any: "Requests changes while any finding is open, and approves when none is.",
};

/** What the choice means for the selected review kind, in one sentence. */
export const VERDICT_KIND_NOTES: Record<ProjectReviewKind, string> = {
  dynamic:
    "In a Dynamic Review a P0 finding blocks; the lower priorities (P1 to P3) only count under Any finding.",
  diff: "PR-Agent gives its findings no severity, so Blocking findings only submits no review for a Diff Review. Choose Any finding to get a verdict from the findings it keeps as active.",
};

export const VERDICT_COMMON_NOTE =
  "After a successful review Code Reviewer submits the review as itself on the commit that was reviewed, with a link to the review comment. A failed, cancelled or replaced run submits none, and a new push replaces the earlier verdict. A review that is not whole (it stopped at a limit, dropped a finding or left files out) submits none and leaves an earlier request for changes in place; only Off dismisses it. The verdict comes from the model and can be wrong or manipulated, and GitHub does not document that the approval of an App counts towards required approvals: do not rely on it for branch protection, and require a code owner review where a person must approve.";

function isMode(value: string): value is ReviewVerdictMode {
  return REVIEW_VERDICT_MODES.some((mode) => mode === value);
}

export function ReviewVerdictFieldset({
  value,
  kind,
  defaultMode,
  source,
  error,
  disabled,
  onChange,
}: {
  value: ReviewVerdictMode;
  /** The review kind selected in the form: the note says what blocking means for it. */
  kind: ProjectReviewKind;
  defaultMode: ReviewVerdictMode;
  /** Whether the saved value is the project's own or the default. */
  source: "built_in" | "project";
  error: string | undefined;
  disabled: boolean;
  onChange: (mode: ReviewVerdictMode) => void;
}) {
  const ids = useId();
  const errorId = `${ids}-error`;
  return (
    <SettingsCard title="Review verdict" disabled={disabled}>
      <p className="text-sm text-muted-foreground">{VERDICT_COMMON_NOTE}</p>
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
                <span className="font-medium text-foreground">
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
        {VERDICT_KIND_NOTES[kind]}
      </p>
      <p className="text-sm text-muted-foreground">
        {source === "project" ? "Set for this project." : "Built-in value."}
      </p>
    </SettingsCard>
  );
}
