// SPDX-License-Identifier: Apache-2.0

// The copy for the codes of the LLM key routes (the UI translates a code to copy, never the other way round).
// No sentence here contains a value; a provider's own words only ever appear as the `detail` the server cleaned.
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import { NOT_AVAILABLE_TO_YOU } from "../../copy/messages.ts";
import type { LlmKeyIssueCode } from "../workspace-key.ts";

const ISSUE_COPY: Record<LlmKeyIssueCode, string> = {
  provider_invalid: "This instance does not support that provider.",
  api_key_invalid:
    "That does not look like an API key: it may have no spaces or line breaks inside and at most 4096 characters. Copy it again from the provider.",
  api_key_required: "Enter the API key. There is no saved key to keep.",
};

export function describeLlmKeyIssue(code: string): string {
  return Object.hasOwn(ISSUE_COPY, code)
    ? ISSUE_COPY[code as LlmKeyIssueCode]
    : GENERIC_FAILURE;
}

const FAILURE_COPY: Record<string, string> = {
  forbidden: "Only an Admin or an Owner of this workspace can change the key.",
  not_found: NOT_AVAILABLE_TO_YOU,
  provider_not_found: "This instance does not support that provider.",
  cross_site_request:
    "The request did not come from this page. Reload it and try again.",
  unsupported_content_type: GENERIC_FAILURE,
  body_too_large: "That is far too long for an API key.",
  invalid_input: "The key could not be saved. Check the fields.",
  rate_limited:
    "The key was tested too often. Wait a few minutes and try again.",
};

export function describeLlmKeyFailure(code: string): string {
  return (
    describeTransportFailure(code) ?? FAILURE_COPY[code] ?? GENERIC_FAILURE
  );
}

const TEST_FAILURE_COPY: Record<string, string> = {
  llm_key_rejected:
    "The provider did not accept this key. Check that it is complete, has not been revoked and has credit.",
  llm_unreachable:
    "The provider could not be reached, or did not answer in time. Try again in a moment.",
  llm_provider_error:
    "The provider answered with an error. The key may be fine; try again later.",
  llm_provider_address_changed:
    "The address of this provider changed after a project selected it, so the key was not sent anywhere. An Owner or Admin can check the provider and confirm the new address in the review settings of the project.",
};

export function describeKeyTestFailure(code: string): string {
  return TEST_FAILURE_COPY[code] ?? GENERIC_FAILURE;
}
