// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the chooser of a workspace that reviews on the code-review.com key (#283, #433, #675). Such a workspace picks
// an entry of the catalog (ADR 0005) for each kind of review, never a model: an entry is shown by the name and the
// description the operator wrote under the name of its model provider, which comes from the data and not from these
// words. Nothing here names a model, a vendor, a price or a cost. A test scans every string (`model-choice.test.ts`); the
// sentences about the plan are the one place where the word "plan" is needed.

import { PRODUCT_NAME } from "./product-name.ts";

export const MODEL_CHOICE_HEADING = "Quality";

/** Next to the dropdowns of a workspace on the code-review.com key (#675): who the reviews are billed through. It is not a provider. */
export const MODEL_CHOICE_BILLED_NOTE = `Billed via ${PRODUCT_NAME}`;

/** The option of the provider dropdown that takes the choice back, so the default of code-review.com applies (#675: it is not a provider, so it does not carry the name). */
export const MODEL_CHOICE_DEFAULT_OPTION = "Default";

/** The one sentence under the heading. */
export const MODEL_CHOICE_HINT = `How reviews of this kind are done. ${PRODUCT_NAME} takes care of the rest.`;

/** Under the heading while the project has chosen nothing: the default of code-review.com applies. */
export const MODEL_CHOICE_DEFAULT_SOURCE = `${PRODUCT_NAME} default`;

/** Under the choices while none is made. */
export const MODEL_CHOICE_NONE_CHOSEN = `Nothing is chosen yet, so the ${PRODUCT_NAME} default applies.`;

/** Instead of the choices while code-review.com has none for the kind. */
export const MODEL_CHOICE_NONE_OFFERED = `${PRODUCT_NAME} offers no choice for this kind of review yet. Reviews use its default.`;

/** Next to an entry the workspace's plan does not include. */
export const MODEL_CHOICE_LOCKED_BADGE = "Not included in your plan";

/** The link next to a locked entry; it leads to the plan page of the workspace. */
export const MODEL_CHOICE_MANAGE_PLAN = "Manage plan";

/** Next to an entry that was taken out of the catalog while the project still has it chosen. */
export const MODEL_CHOICE_RETIRED_BADGE = "No longer available";

/** Under the choices while the one in force cannot be used: its reviews would not start. */
export const MODEL_CHOICE_CHOSEN_UNAVAILABLE =
  "The chosen option is not available right now, so reviews do not start until another one is chosen.";

/** On the workspace defaults, which hold no choice (an entry is chosen per project). */
export const MODEL_CHOICE_PER_PROJECT_NOTE =
  "The quality of reviews is chosen for each project, on the settings page of that project.";
