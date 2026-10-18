// SPDX-License-Identifier: Apache-2.0

// The copy for what the catalog data routes answer: one sentence per stable code (src/model-catalog/admin-errors.ts) and
// for the problems of the fields of the form. The codes are the contract, these sentences are only what the page shows.
// The page is for the operator, who sees the real model ids; the sentences still never repeat one.
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  UNAVAILABLE,
} from "../../copy/messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: CROSS_SITE_REQUEST,
  unsupported_content_type:
    "The request was not sent in the format the server expects. Reload the page and try again.",
  body_too_large: "The request was too large. Shorten the text and try again.",
  invalid_input: INVALID_VALUES,
  unavailable: UNAVAILABLE,
  model_change_not_confirmed:
    "Changing the model behind a released entry needs your confirmation. Reload the page and try again.",
  request_invalid:
    "The request was not in the shape the server expects. Reload the page and try again.",
  name_invalid:
    "Enter a name of 1 to 40 characters, without a space at either end and without line breaks.",
  name_reveals_model:
    "This name gives away the model, its id or its provider. Members see the name, so choose one that says what the entry is for, for example Small or Thorough.",
  catalog_name_taken:
    "Another entry has this name already. Names are compared without regard to upper and lower case.",
  description_invalid:
    "The description is longer than 160 characters, has more than one line, or speaks of a model, a vendor, a price or a cost. Members read it, so describe speed and depth only.",
  PROVIDER_UNKNOWN: "Choose one of the providers in the list.",
  model_id_invalid:
    "This is not a model id the provider accepts. It looks like vendor/model-name, without spaces.",
  kinds_invalid:
    "Choose at least one kind of review that the entry serves: Diff, Dynamic or both.",
  CATALOG_ENTRY_UNKNOWN:
    "This entry does not exist any more. Reload the page to see the catalog as it is now.",
  CATALOG_ENTRY_NOT_RELEASED:
    "Only a released entry can be a default. Release the entry first.",
  CATALOG_ENTRY_KIND_MISMATCH:
    "This entry does not serve that kind of review, so it cannot be the default of it.",
  catalog_transition_invalid:
    "The entry cannot move to that status from where it is. Reload the page to see its status now.",
  catalog_entry_not_draft:
    "Only a draft can be deleted. A released or retired entry stays, because projects and earlier runs refer to it. Retire it instead.",
  catalog_entry_is_default:
    "This entry is the default of a kind. Choose another default for that kind first, then retire the entry or narrow its kinds.",
  catalog_conflict:
    "The entry changed meanwhile, in another tab or by another admin, and nothing was saved. Reload the page and try again.",
  MODEL_UNKNOWN:
    "The provider does not know this model. Check the model id and try again.",
  DYNAMIC_MODEL_TOOLS_UNSUPPORTED:
    "This model does not support the tool calling that Dynamic reviews need. Choose another model, or let the entry serve Diff only.",
  DYNAMIC_MODEL_UNKNOWN:
    "The provider does not know this model, so it cannot serve Dynamic reviews. Check the model id and try again.",
  DYNAMIC_MODEL_UNVERIFIED:
    "The provider could not be asked whether this model supports Dynamic reviews. Try again in a moment.",
};

/** The sentence for a failed change or call. */
export function describeCatalogFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for a problem with one field: the same sentences, by the code the server gave the field. */
export function describeCatalogIssue(issue: RequestIssue): string {
  return describeCatalogFailure(issue.code);
}

/** What "Check model" found, when the provider vouches for the model. */
export function describeCheckSuccess(verified: boolean): string {
  return verified
    ? "The provider knows this model and it supports what these kinds need."
    : "The provider could not be asked, so the model is not verified. A Diff entry can still be saved; the check runs again when you release it.";
}
