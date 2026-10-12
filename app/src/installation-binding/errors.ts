// SPDX-License-Identifier: Apache-2.0

// The stable codes of the binding of an installation to a workspace. A page translates a code to copy
// (ui/messages.ts), never the other way round, and no code carries a secret, a state, a token or the name of
// another workspace. Two sets:
//
// - the refusals (`BINDING_ERROR_CODES`): nothing was linked and nothing was requested;
// - the outcomes that are not a failure but are not "linked" either (`BINDING_WAITING_CODES`).
//
// `installation_already_linked` is deliberately one answer for every installation that belongs to a workspace
// other than the asking one: it does not say which workspace, and it is only reached after the person has shown
// that they may use the installation at all (src/installation-binding/service.ts), so a guessed id learns
// nothing from it.
export const BINDING_ERROR_CODES = [
  /** The state is forged, expired, used, or belongs to another person, session or purpose. */
  "state_invalid",
  /** The signed in person is not (or no longer) an Owner or Admin of the workspace. */
  "workspace_role_required",
  /** There is no GitHub App configured, so there is no installation page to go to. */
  "github_app_not_configured",
  /** A multi-tenant instance cannot check a person's rights without the user authorization of the App. */
  "user_authorization_not_configured",
  /** The person cancelled at GitHub. */
  "access_denied",
  /** GitHub did not accept the authorization: the person has to authorize again. */
  "github_authorization_required",
  /** GitHub could not be reached or answered something unusable; nothing was linked. */
  "github_unreachable",
  /** The installation id of the callback is not a number. */
  "installation_id_invalid",
  /** The installation is not among the installations the person's token can use. */
  "installation_not_accessible",
  /** The person can use the installation but does not own or administer its account. */
  "not_installation_admin",
  /** The installation belongs to a workspace other than this one. */
  "installation_already_linked",
  /** The GitHub account belongs to another user of this instance. */
  "identity_belongs_to_other_user",
  /** The person has another GitHub account linked than the one that authorized. */
  "github_identity_mismatch",
  /** The choice in the list of installations is not (any more) in that list. */
  "picker_invalid",
  /** The connection to end is not one of this workspace. */
  "integration_not_found",
  "rate_limited",
  /** The counters or the database could not be read; nothing was done. */
  "unavailable",
] as const;
export type BindingErrorCode = (typeof BINDING_ERROR_CODES)[number];

export const BINDING_WAITING_CODES = [
  /** `setup_action=request`: GitHub asked the owners of the account to approve; nothing is linked yet. */
  "waiting_for_github_approval",
  /** The role could not be read: the instance admin decides. */
  "waiting_for_instance_admin",
] as const;
export type BindingWaitingCode = (typeof BINDING_WAITING_CODES)[number];

/** Everything a page can be told about a binding: a refusal, a wait, or `linked`. */
export const BINDING_RESULT_CODES = [
  "linked",
  /** The list of installations to choose from is ready. */
  "picker_ready",
  ...BINDING_WAITING_CODES,
  ...BINDING_ERROR_CODES,
] as const;
export type BindingResultCode = (typeof BINDING_RESULT_CODES)[number];

export function isBindingResultCode(
  value: unknown,
): value is BindingResultCode {
  return BINDING_RESULT_CODES.some((code) => code === value);
}

/** The HTTP status of a refusal on a data route. */
export const BINDING_ERROR_STATUS: Record<BindingErrorCode, number> = {
  state_invalid: 403,
  workspace_role_required: 403,
  github_app_not_configured: 409,
  user_authorization_not_configured: 409,
  access_denied: 403,
  github_authorization_required: 401,
  github_unreachable: 502,
  installation_id_invalid: 422,
  installation_not_accessible: 403,
  not_installation_admin: 403,
  installation_already_linked: 409,
  identity_belongs_to_other_user: 409,
  github_identity_mismatch: 409,
  picker_invalid: 422,
  integration_not_found: 404,
  rate_limited: 429,
  unavailable: 503,
};

/** The refusals of the instance admin's decision on a request (src/installation-binding/approvals.ts). */
export const APPROVAL_ERROR_CODES = [
  "cross_site_request",
  "unsupported_content_type",
  "body_too_large",
  "invalid_input",
  /** The request does not exist. */
  "request_not_found",
  /** The request was decided or withdrawn already; a request is decided once. */
  "request_not_pending",
  /** The person who asked is not an Owner or Admin of the workspace any more. */
  "requester_not_admin",
  /** The installation is linked to another workspace now. */
  "installation_already_linked",
  /** GitHub does not know the installation (any more). */
  "installation_not_accessible",
  "github_unreachable",
  "unavailable",
] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];

export const APPROVAL_ERROR_STATUS: Record<ApprovalErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  request_not_found: 404,
  request_not_pending: 409,
  requester_not_admin: 409,
  installation_already_linked: 409,
  installation_not_accessible: 409,
  github_unreachable: 502,
  unavailable: 503,
};
