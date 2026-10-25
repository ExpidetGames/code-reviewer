// SPDX-License-Identifier: LicenseRef-Proprietary

// What a change of the kind of the workspace defaults does to the projects that follow it (#676), said before the
// change is confirmed: by the settings form when the kind is switched and by the reset of every default.
import { KIND_NAMES } from "../kind-names.ts";
import type { ProjectReviewKind } from "../settings.ts";

const SUMMARY_COMMENT_NOTE =
  "The next review of such a project posts a new summary comment on the pull request; the findings of the current comment are not carried over.";

export function followersText(
  kind: ProjectReviewKind,
  following?: number,
): string {
  if (following === undefined)
    return `Every project that sets no review kind of its own switches to ${KIND_NAMES[kind]}. Their reviews that are still waiting are cancelled, and a review that is already running finishes. ${SUMMARY_COMMENT_NOTE}`;
  if (following === 0)
    return `No existing project follows this default, so nothing switches; projects that are added later start with ${KIND_NAMES[kind]}.`;
  const who =
    following === 1
      ? "1 project follows this default and switches"
      : `${String(following)} projects follow this default and switch`;
  return `${who} to ${KIND_NAMES[kind]}. Their reviews that are still waiting are cancelled, and a review that is already running finishes. ${SUMMARY_COMMENT_NOTE}`;
}
