// SPDX-License-Identifier: LicenseRef-Proprietary

// What a run's error code means, in words for a person who does not run the servers. The codes come
// from three places: the queue (`JOB_ERROR_CODES`), the claim of the runner API (`CLAIM_FAILURE_CODES`
// and `CLAIM_RELEASE_REASONS`) and the runner itself (`RUNNER_ERROR_CODES`). A test requires a text
// for every code of those lists, so a new code cannot ship without one. A code nobody knows (a newer
// runner, a changed database) gets a general sentence and is shown as it is, never as a crash.
//
// Nothing here repeats what a runner or a pull request wrote: the texts are fixed, and the code is
// shown only when it has the plain shape of a code.

/**
 * Codes that no part of the system produces any more but that stored runs still carry: they keep their sentence and
 * are no part of the lists a test requires a sentence for.
 */
export const HISTORIC_ERROR_CODES = ["managed_tier_unavailable"] as const;

/**
 * Codes that are never shown to the customer, in the check run, on the run page or in any answer: the sentence says all
 * there is to say. The code of the hidden hourly brake (#499) is one: it would tell a reader that a count exists.
 */
export const UNSHOWN_ERROR_CODES = ["reviews_paused"] as const;

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
  no_capable_runner:
    "No runner that can run this kind of review picked up the run within the time limit, so it was cancelled. It will run again on the next push or review request.",
  dispatch_unavailable:
    "No worker picked up this run within the time limit, so it was stopped. The service that starts workers may be down or fully busy. It will run again on the next push or review request.",
  dynamic_review_disabled:
    "Dynamic Review is not switched on yet, so this run could not start. Ask whoever runs the server to turn it on, or switch the project to Diff Review on its settings page.",
  workspace_suspended:
    "Reviews are paused for this workspace, so this run did not start and no AI model was used. Ask whoever manages this workspace's plan.",
  quota_exhausted:
    "This workspace has used up what its plan allows for the current period, so this run did not start and no AI model was used. Reviews start again when the period renews or the limit is raised.",
  entitlements_invalid:
    "The plan settings of this workspace could not be read, so this run did not start and no AI model was used. Ask whoever manages this workspace's plan to check them.",
  balance_negative:
    "The balance of this workspace is below zero, so this run did not start and no AI model was used. Add credit to continue.",
  insufficient_balance:
    "The balance of this workspace is used up, so this run did not start and no AI model was used. Add credit to continue.",
  billing_rates_incomplete:
    "This run did not start because the billing setup is not complete, and no AI model was used. Ask whoever runs code-review.com.",
  billing_hold_released:
    "The credit held for this run was released before it could start, so it did not start and no AI model was used. It will run again on the next push or review request.",
  monthly_limit_reached:
    "The monthly spending limit of this workspace was reached, so this run did not start and no AI model was used. An Owner or Admin of the workspace can change the limit in the workspace settings.",
  reviews_paused:
    "Reviews are paused for this workspace for a while, so this run did not start and no AI model was used. It will run again on the next push or review request.",
  billing_limits_unreadable:
    "The spending limits of this workspace could not be checked, so this run did not start and no AI model was used. It will run again on the next push or review request. If this keeps happening, ask whoever runs code-review.com.",
  // A code of a job from before the catalog (#434): nothing ends a job with it any more (see HISTORIC_ERROR_CODES).
  managed_tier_unavailable:
    "The quality level chosen for this project was not available when this run was made, so it did not start and no AI model was used. Quality levels have since been replaced by review options, which a workspace Owner or Admin can choose in the review settings of the project.",

  managed_model_unavailable:
    "The review option chosen for this project is not available right now, so this run did not start and no AI model was used. A workspace Owner or Admin can choose another option in the review settings of the project. If none is available, contact whoever runs code-review.com.",
  llm_provider_unsupported:
    "The AI provider chosen in the model settings of this project cannot be used for this run, so it did not start and no AI model was used. Check the model settings of the project, or ask whoever runs code-review.com.",

  llm_model_unavailable:
    "The AI model chosen in the model settings of this project is not available any more, so this run did not start and no AI model was used. Choose another model in the review settings of the project.",

  provider_address_changed:
    "The address of the AI provider chosen in the model settings of this project has changed since it was chosen, so this run did not start, your AI key was not sent anywhere and no AI model was used. An Owner or Admin of the workspace can check the provider and confirm the new address in the review settings of the project.",

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
    "The model settings of this project, for a Dynamic Review its Dynamic model too, could not be used for this run. Check them on the project page.",
  git_access_unavailable:
    "GitHub could not be reached to prepare this run, even after several tries.",
  pull_request_unavailable:
    "The pull request could not be read from GitHub, even after several tries.",
  claim_failed:
    "The server could not prepare this run, even after several tries.",
  price_check_failed:
    "The server could not check the model for this run, even after several tries.",
  provider_pin_check_failed:
    "The server could not check the address of the model provider for this run, even after several tries.",
  launch_failed:
    "The worker for this run could not be started, even after several tries.",
  worker_exited:
    "The worker for this run stopped with an error before it reported a result, even after several tries.",

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
    "No review was posted on the pull request. Either the engine did not post one, or the earlier review on the pull request belongs to a commit this run cannot account for.",
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
  llm_context_length_exceeded:
    "The request was larger than the model's context window, so the AI provider refused it. Choose a model with a larger window, or review a smaller pull request.",
  llm_output_invalid:
    "The AI model answered in a form the review engine could not use.",
  model_unknown: "The configured model is not known to the AI provider.",
  llm_parameters_unsupported:
    "No provider can serve this model with everything the review asks for, so the AI service refused the request. Choose another model for this project.",
  runner_shutdown: "The runner was shut down while it worked on this run.",
  dynamic_engine_unavailable:
    "This run needs something no runner that answered has available yet: the Dynamic Review engine, or, for a project with a cost limit, a runner that can enforce that limit.",
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
  // The sentence for a reader who does not know whose limit it was (a list row, a runner that did not say): true for both.
  cost_limit_reached:
    "The review stopped at its cost limit: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. The limit is the one set for this project under Limits in the project settings, or the maximum cost per review set by code-review.com, whichever is lower.",
  dynamic_model_features_unsupported:
    "The configured model does not support the features Dynamic Review requires. Choose another model.",
  lease_lost:
    "When the review was ready, the job was no longer held by its runner or this could not be confirmed, so nothing was written. The next push reviews again.",
  superseded:
    "A newer push replaced this run while it was running, so it was stopped and published nothing.",
  unknown: "The run failed for a reason this version does not know.",
};

/**
 * Why a Dynamic Review checkout failed (`RUNNER_CHECKOUT_REASONS`), in words. The runner reports the
 * name next to the code `checkout_incomplete`; a test requires a sentence for every name.
 */
export const CHECKOUT_REASON_COPY: Readonly<Record<string, string>> = {
  invalid_request:
    "The job or its limits could not be used to prepare the repository checkout.",
  ref_moved:
    "The pull request changed while the checkout was prepared, so nothing was reviewed. The next push reviews again.",
  ref_missing:
    "The pull request or its base branch could not be found on GitHub.",
  protocol: "GitHub answered in a form the checkout could not read.",
  pack_invalid: "The repository data GitHub sent could not be verified.",
  object_missing:
    "A file the checkout needed was missing from what GitHub sent.",
  tree_invalid: "The file tree of the repository could not be read.",
  entries: "The repository has more files than a Dynamic Review can prepare.",
  path_invalid: "A file path in the repository cannot be exported safely.",
  budget_transfer:
    "The repository is larger to download than a Dynamic Review allows.",
  budget_preparation:
    "The repository is larger to prepare than a Dynamic Review allows.",
  budget_exposed:
    "The text files of the repository are more than a Dynamic Review may read.",
  diff_too_large:
    "The change of this pull request is larger than a Dynamic Review can read.",
  input_too_large:
    "The description or the earlier review state of the pull request is larger than a Dynamic Review can use.",
  cancelled: "The run was stopped while the checkout was prepared.",
  timeout: "Preparing the repository checkout took longer than the time limit.",
  transport:
    "GitHub refused the request or could not be reached while the checkout was prepared.",
  isolation: "The checkout could not be sealed safely for the review engine.",
  context:
    "The title, the description or the earlier review state of the pull request could not be read.",
};

export const UNKNOWN_REASON_COPY =
  "The checkout failed for a reason this version of code-review.com does not know. The reason below helps whoever runs the server to look it up.";

export const UNKNOWN_ERROR_COPY =
  "The run ended with an error this version of code-review.com does not know. The error code below helps whoever runs the server to look it up.";

/** A code is a short word with underscores; anything else is not shown. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * #689: a Diff Review that is stopped at its cost limit ends with one code whichever limit it was; the runner names the limit in
 * `usage.stoppedEarly`. The customer can change their own limit but not the maximum of code-review.com, so the text says which.
 */
const COST_LIMIT_REACHED_COPY: Readonly<Record<string, string>> = {
  project_cost_limit:
    "The review stopped at the cost limit set for this project: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. You can change the limit under Limits in the project settings.",
  cost_limit:
    "The review stopped at the maximum cost per review set by code-review.com: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. This maximum is not a setting of the project.",
};

export type ErrorDescription = {
  /** The code as stored when it has the shape of one, otherwise null (it is never shown then). */
  code: string | null;
  /** The sentence for a person. */
  text: string;
  /** Whether the code has a text of its own. */
  known: boolean;
};

/** `stoppedEarly` is the limit the runner reported in the usage of the run (`cost_limit`, `project_cost_limit`), when it did. */
export function describeErrorCode(
  code: string,
  stoppedEarly?: string | null,
): ErrorDescription {
  const shown = CODE_SHAPE.test(code) ? code : null;
  if (shown !== null && Object.hasOwn(ERROR_COPY, shown)) {
    const bound =
      shown === "cost_limit_reached" &&
      stoppedEarly !== undefined &&
      stoppedEarly !== null &&
      Object.hasOwn(COST_LIMIT_REACHED_COPY, stoppedEarly)
        ? COST_LIMIT_REACHED_COPY[stoppedEarly]
        : undefined;
    return {
      code: (UNSHOWN_ERROR_CODES as readonly string[]).includes(shown)
        ? null
        : shown,
      text: bound ?? ERROR_COPY[shown] ?? UNKNOWN_ERROR_COPY,
      known: true,
    };
  }
  return { code: shown, text: UNKNOWN_ERROR_COPY, known: false };
}

export type ReasonDescription = {
  code: string;
  text: string;
  known: boolean;
};

/** The sentence for a checkout reason; null when the value is not shaped like a reason (it is never shown). */
export function describeCheckoutReason(
  reason: string,
): ReasonDescription | null {
  if (!CODE_SHAPE.test(reason)) return null;
  if (Object.hasOwn(CHECKOUT_REASON_COPY, reason))
    return {
      code: reason,
      text: CHECKOUT_REASON_COPY[reason] ?? UNKNOWN_REASON_COPY,
      known: true,
    };
  return { code: reason, text: UNKNOWN_REASON_COPY, known: false };
}
