// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the chooser of a workspace that reviews on the operator's key (#283, #433). Such a workspace picks an
// entry of the catalog (ADR 0005) for each kind of review, never a model: an entry is shown by the name and the
// description the operator wrote, and nothing here names a model, a vendor, a price or a cost. A test scans every
// string (`model-choice.test.ts`); the sentences about the plan are the one place where the word "plan" is needed.

import { PRODUCT_NAME } from "./product-name.ts";

export const MODEL_CHOICE_HEADING = "Quality";

/** The one provider of a workspace on the operator's key (#656): the first dropdown names who runs the reviews, not a vendor. */
export const MODEL_CHOICE_PROVIDER = PRODUCT_NAME;

/** The option that takes the choice back, so the default of the instance applies. */
export const MODEL_CHOICE_DEFAULT_OPTION = "Default of this instance";

/** The one sentence under the heading. */
export const MODEL_CHOICE_HINT =
  "How reviews of this kind are done. This instance takes care of the rest.";

/** Under the heading while the project has chosen nothing: the choice of the instance applies. */
export const MODEL_CHOICE_DEFAULT_SOURCE = "Default of this instance";

/** Under the choices while none is made. */
export const MODEL_CHOICE_NONE_CHOSEN =
  "Nothing is chosen yet, so the default of this instance applies.";

/** Instead of the choices while the instance has none for the kind. */
export const MODEL_CHOICE_NONE_OFFERED =
  "This instance offers no choice for this kind of review yet. Reviews use its default.";

/** Next to an entry the workspace's plan does not include. */
export const MODEL_CHOICE_LOCKED_BADGE = "Not included in your plan";

/** The link next to a locked entry; it leads to the plan page of the workspace. */
export const MODEL_CHOICE_MANAGE_PLAN = "Manage plan";

/** Next to an entry that was taken out of the catalog while the project still has it chosen. */
export const MODEL_CHOICE_RETIRED_BADGE = "No longer available";

/** Under the choices while the one in force cannot be used: its reviews would not start. */
export const MODEL_CHOICE_CHOSEN_UNAVAILABLE =
  "The chosen option is not available right now, so reviews do not start until another one is chosen.";
