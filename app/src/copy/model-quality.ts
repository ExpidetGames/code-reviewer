// SPDX-License-Identifier: Apache-2.0

// The words of the quality choice of a workspace that reviews on the operator's key (#283). A workspace on the
// operator's key chooses a level, never a model: each level is described by speed and depth only. Nothing in this
// module names a model, a vendor, a price or a cost, and a test scans every string (`model-quality.test.ts`).
import type { ModelTier } from "../model-tiers/tiers.ts";

export const QUALITY_HEADING = "Quality";

/** The one sentence under the heading. */
export const QUALITY_HINT =
  "How quickly and how deeply reviews look at a change. This instance takes care of the rest.";

/** The three levels, lightest first: the label and what it means for speed and depth. */
export const QUALITY_LEVELS: ReadonlyArray<{
  tier: ModelTier;
  label: string;
  description: string;
}> = [
  {
    tier: "low",
    label: "Low",
    description:
      "Faster, lighter reviews that point out the obvious problems quickly.",
  },
  {
    tier: "medium",
    label: "Medium",
    description: "A balance of speed and depth that suits most pull requests.",
  },
  {
    tier: "high",
    label: "High",
    description:
      "Slower, deeper reviews that take more time to look at a change closely.",
  },
];

/** Next to a level that cannot be chosen right now. It never says why, or what would make it available. */
export const QUALITY_UNAVAILABLE_BADGE = "Not available";

/** Under the choice while the level in force cannot be used: its reviews would not start. */
export const QUALITY_CHOSEN_UNAVAILABLE =
  "The chosen level is not available right now, so reviews do not start until another level is chosen.";
