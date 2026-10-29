// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the chooser of a workspace that reviews on the code-review.com key (#283, #433, #675). Such a workspace picks
// an entry of the catalog (ADR 0005) for each kind of review, never a model: an entry is shown by the name and the
// description the operator wrote under the name of its model provider, which comes from the data and not from these
// words. Nothing here names a model, a vendor, a price or a cost. A test scans every string (`model-choice.test.ts`); the
// sentences about the plan are the one place where the word "plan" is needed.

import type { ProductIdentity } from "../product-identity/identity.ts";

export const MODEL_CHOICE_HEADING = "Quality";

/** The option of the provider dropdown that takes the choice back, so the default of code-review.com applies (#675: it is not a provider, so it does not carry the name). */
export const MODEL_CHOICE_DEFAULT_OPTION = "Default";

/** The provider dropdown while the entry in force is not in the list any more (#675): it is neither the default nor a provider. */
export const MODEL_CHOICE_UNAVAILABLE_OPTION = "Unavailable option";

/** Next to an entry the workspace's plan does not include. */
export const MODEL_CHOICE_LOCKED_BADGE = "Not included in your plan";

/** The link next to a locked entry; it leads to the plan page of the workspace. */
export const MODEL_CHOICE_MANAGE_PLAN = "Manage plan";

/** Next to an entry that was taken out of the catalog while the project still has it chosen. */
export const MODEL_CHOICE_RETIRED_BADGE = "No longer available";

/** Under the choices while the one in force cannot be used: its reviews would not start. */
export const MODEL_CHOICE_CHOSEN_UNAVAILABLE =
  "The chosen option is not available right now, so reviews do not start until another one is chosen.";

/**
 * The sentences of the chooser that name the product (#715, cut 7): the application hands in the product, the words are
 * made from its name. For code-review.com they read as they did when the name was a constant here.
 */
export function modelChoiceWords(product: ProductIdentity) {
  const { name } = product;
  return {
    /** Next to the dropdowns of a workspace on the operator's key (#675): who the reviews are billed through. It is not a provider. */
    billedNote: `Billed via ${name}`,
    /** The one sentence under the heading. */
    hint: `How reviews of this kind are done. ${name} takes care of the rest.`,
    /** Under the heading while the project has chosen nothing: the default of the product applies. */
    defaultSource: `${name} default`,
    /** Under the choices while none is made. */
    noneChosen: `Nothing is chosen yet, so the ${name} default applies.`,
    /** Instead of the choices while the product has none for the kind. */
    noneOffered: `${name} offers no choice for this kind of review yet. Reviews use its default.`,
  } as const;
}
