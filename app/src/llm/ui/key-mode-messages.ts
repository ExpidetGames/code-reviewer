// SPDX-License-Identifier: Apache-2.0

// The copy of the key mode card (#496). One honest sentence for each choice about what is charged: no rate, no formula. The UI
// translates a code to copy, never the other way round; no sentence contains a value.
import { NOT_AVAILABLE_TO_YOU } from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

export const KEY_MODE_HEADING = "Which key reviews use";
export const KEY_MODE_INTRO =
  "Choose whose AI access the reviews of this workspace run on. A review that has started is not affected by a change; the choice applies to the reviews that start after it.";
export const MANAGED_LABEL = "Use our models";
export const MANAGED_TEXT =
  "Reviews run on our models and are charged for AI and infrastructure.";
export const OWN_LABEL = "Use my own provider key";
export const OWN_TEXT =
  "Reviews run on the API key you save below and are charged for infrastructure only; your provider bills you for the AI.";
export const OWN_KEY_FIRST_HINT =
  "Save a provider key below first to use this option.";
export const MANAGED_KEY_UNUSED_NOTE =
  "A key you saved stays stored and is not used while this workspace uses our models.";
export const READ_ONLY_NOTE =
  "Only an Admin or an Owner of the workspace can change this.";
export const SAVE_CHOICE_BUTTON = "Save choice";
export const SAVE_CHOICE_LOADING = "Saving the choice";
export const CHOICE_SAVED = "The choice is saved.";

const FAILURE_COPY: Record<string, string> = {
  forbidden: READ_ONLY_NOTE,
  not_found: NOT_AVAILABLE_TO_YOU,
  own_key_missing:
    "Save an API key for your own provider first, then choose your own key.",
  key_mode_invalid: "Choose one of the two options.",
  cross_site_request:
    "The request did not come from this page. Reload it and try again.",
  unsupported_content_type: GENERIC_FAILURE,
  body_too_large: GENERIC_FAILURE,
};

export function describeKeyModeFailure(code: string): string {
  return (
    describeTransportFailure(code) ?? FAILURE_COPY[code] ?? GENERIC_FAILURE
  );
}
