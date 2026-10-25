// SPDX-License-Identifier: LicenseRef-Proprietary

// The token budget of a review (#689). It is no setting of a workspace or a project any more: the app decides it for
// every job from what it knows of the model. Pure: no database, no clock.

/** The smallest token budget a runner accepts (`MIN_LLM_CONTEXT_TOKENS`). */
const MIN_BUDGET = 1000;

/**
 * How much of a pull request goes to the model at once while nothing says the model holds less. It is PR-Agent's own 32 000
 * widened on purpose, and what the setting held for every workspace that never changed it (so no review changes with the
 * removal of the setting); a larger window does not make a review larger, since a bigger prompt costs more and the
 * chunking of large pull requests exists for the rest.
 */
export const DEFAULT_REVIEW_TOKEN_BUDGET = 100_000;

/**
 * The token budget of a job: the built-in value, cut down to the context window of its model when that window is known
 * and smaller. Never below what a runner accepts.
 */
export function reviewTokenBudget(contextWindow: number | null): number {
  if (contextWindow === null || contextWindow >= DEFAULT_REVIEW_TOKEN_BUDGET)
    return DEFAULT_REVIEW_TOKEN_BUDGET;
  return Math.max(contextWindow, MIN_BUDGET);
}
