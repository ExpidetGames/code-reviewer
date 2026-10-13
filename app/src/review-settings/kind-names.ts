// SPDX-License-Identifier: Apache-2.0

// What the two review kinds are called to a person. The settings form and the Runs pages use the same
// names, so a run reads as the kind the project chose.
import type { ProjectReviewKind } from "./settings.ts";

export const KIND_NAMES: Record<ProjectReviewKind, string> = {
  diff: "Diff Review",
  dynamic: "Dynamic Review",
};
