// SPDX-License-Identifier: Apache-2.0

// What a run's error code means, in words for a person who does not run the servers. The codes come
// from three places: the queue (`JOB_ERROR_CODES`), the claim of the runner API (`CLAIM_FAILURE_CODES`
// and `CLAIM_RELEASE_REASONS`) and the runner itself (`RUNNER_ERROR_CODES`). A test requires a text
// for every code of those lists, so a new code cannot ship without one. A code nobody knows (a newer
// runner, a changed database) gets a general sentence and is shown as it is, never as a crash.
//
// Nothing here repeats what a runner or a pull request wrote: the texts are fixed, and the code is
// shown only when it has the plain shape of a code.

export const ERROR_COPY: Readonly<Record<string, string>> = {
  // The queue
  lease_expired:
    "The runner stopped reporting while it worked on this run, and the run ran out of retries.",
  timeout: "The run took longer than the time limit, so it was stopped.",
  project_deactivated:
    "The project was switched off before this run could start.",
  pull_request_closed:
    "The pull request was closed before this run could start.",
  pull_request_draft:
    "The pull request was turned into a draft before this run could start.",
  command_removed:
    "This command was removed from the product, so the waiting run was cancelled.",
  review_kind_changed:
    "The project's review kind was changed before this run could start, so the waiting run was cancelled.",

  // The claim of the runner API
  llm_not_configured:
    "No access to an AI model is set up on this server. Ask whoever runs it to set the LLM provider and key.",
  git_connection_disabled:
    "The GitHub connection of this repository is switched off.",
  git_connection_gone:
    "The GitHub connection of this repository no longer exists.",
  git_connection_suspended: "The GitHub App is suspended for this account.",
  git_scope_refused:
    "GitHub did not give the app the access this review needs.",
  git_app_auth_failed:
    "The server could not sign in to GitHub as the app. Check the GitHub App credentials.",
  git_access_failed:
    "The server could not get access to the repository on GitHub.",
  pr_not_found: "The pull request could not be found on GitHub.",
  job_args_invalid: "The command or arguments of this run could not be used.",
  job_env_invalid:
    "The review settings of this project could not be used for this run. Check them on the project page.",
  job_llm_options_invalid:
    "The model settings of this project could not be used for this run. Check them on the project page.",
  git_access_unavailable:
    "GitHub could not be reached to prepare this run, even after several tries.",
  pull_request_unavailable:
    "The pull request could not be read from GitHub, even after several tries.",
  claim_failed:
    "The server could not prepare this run, even after several tries.",

  // The runner
  invalid_job: "The runner refused the job because it was incomplete.",
  invalid_command: "The command of this run is not one the runner supports.",
  pr_agent_version_mismatch:
    "The review engine in the runner is not the version this server expects.",
  identity_patch_failed:
    "The review engine could not act as the GitHub App. This is a problem of the runner.",
  runner_error: "The runner hit an unexpected error.",
  command_failed: "The review engine reported an error.",
  review_not_published:
    "The review engine finished, but no review was posted on the pull request.",
  review_state_truncated:
    "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
  review_text_truncated:
    "The review was posted, but part of it was cut off because the comment reached GitHub's size limit.",
  git_auth: "GitHub refused the access token of this run.",
  git_forbidden: "GitHub does not allow the app to do this on the repository.",
  git_rate_limit: "GitHub is limiting requests right now. Try again later.",
  git_unavailable: "GitHub could not be reached.",
  git_unprocessable:
    "GitHub could not process the request for this pull request.",
  git_provider_init: "The review engine could not connect to the pull request.",
  llm_auth: "The AI provider refused the API key.",
  llm_quota: "The AI provider says the credit or quota is used up.",
  llm_rate_limit: "The AI provider is limiting requests right now.",
  llm_timeout: "The AI provider took too long to answer.",
  llm_unavailable: "The AI provider could not be reached or is having trouble.",
  llm_bad_request:
    "The AI provider rejected the request, for example because the pull request is too large for the model.",
  llm_output_invalid:
    "The AI model answered in a form the review engine could not use.",
  model_unknown: "The configured model is not known to the AI provider.",
  runner_shutdown: "The runner was shut down while it worked on this run.",
  dynamic_engine_unavailable:
    "This run needs the Dynamic Review engine, which no runner that answered has available yet.",
  dynamic_isolation_self_check_failed:
    "The Dynamic Review engine could not prove its isolation is safe, so no runner advertises it.",
  dynamic_config_invalid:
    "The Dynamic Review settings of this project could not be used for this run. Check them on the project page.",
  checkout_incomplete:
    "The Dynamic Review could not prepare the repository checkout, so it was not started.",
  dynamic_policy_violation:
    "The Dynamic Review stopped because it would have broken a safety rule.",
  dynamic_budget_exceeded:
    "The Dynamic Review used more than its allowed budget and was stopped.",
  dynamic_accounting_failed:
    "The Dynamic Review's model usage could not be accounted for, so it was stopped.",
  dynamic_model_features_unsupported:
    "The configured model does not support the features Dynamic Review requires. Choose another model.",
  unknown: "The run failed for a reason this version does not know.",
};

export const UNKNOWN_ERROR_COPY =
  "The run ended with an error this version of Code Reviewer does not know. The error code below helps whoever runs the server to look it up.";

/** A code is a short word with underscores; anything else is not shown. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

export type ErrorDescription = {
  /** The code as stored when it has the shape of one, otherwise null (it is never shown then). */
  code: string | null;
  /** The sentence for a person. */
  text: string;
  /** Whether the code has a text of its own. */
  known: boolean;
};

export function describeErrorCode(code: string): ErrorDescription {
  const shown = CODE_SHAPE.test(code) ? code : null;
  if (shown !== null && Object.hasOwn(ERROR_COPY, shown)) {
    return {
      code: shown,
      text: ERROR_COPY[shown] ?? UNKNOWN_ERROR_COPY,
      known: true,
    };
  }
  return { code: shown, text: UNKNOWN_ERROR_COPY, known: false };
}
