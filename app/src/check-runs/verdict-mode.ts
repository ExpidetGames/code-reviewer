// SPDX-License-Identifier: LicenseRef-Proprietary

// The verdict mode a project's stored settings give (#405): its own choice when this version knows it, otherwise the
// default. The same reading the settings page uses (`parseStoredProjectDynamicOverrides`), so what a person sees is
// what the verdict follows, and a stored value that is not valid never breaks a review.
import {
  DEFAULT_REVIEW_VERDICT_MODE,
  type ReviewVerdictMode,
} from "../review-settings/settings.ts";
import {
  parseStoredProjectDynamicOverrides,
  parseStoredWorkspaceDynamic,
} from "../review-settings/validate.ts";

/** The project's own mode, else the workspace default's (#676), else the built-in one. */
export function reviewVerdictOf(
  settings: unknown,
  workspaceDefaults?: unknown,
): ReviewVerdictMode {
  return (
    parseStoredProjectDynamicOverrides(settings).reviewVerdict ??
    parseStoredWorkspaceDynamic(workspaceDefaults).reviewVerdict ??
    DEFAULT_REVIEW_VERDICT_MODE
  );
}
