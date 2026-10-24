// SPDX-License-Identifier: LicenseRef-Proprietary

// The token budget of a job on the operator's key. Pure: no database, no clock.

/** The smallest token budget a runner accepts (`MIN_LLM_CONTEXT_TOKENS`). */
const MIN_BUDGET = 1000;

/**
 * The most a managed job's token budget may be while the context window of its model is not known (the provider
 * cannot be asked and no earlier read is kept). It equals the built-in budget of the review settings
 * (`DEFAULT_MAX_TOKENS`), so a workspace that never changed it is unaffected, and it fits the models an entry is
 * likely to name. A workspace can set a budget up to two million; it must never reach an unknown model unclamped.
 */
export const UNKNOWN_WINDOW_MAX_TOKENS = 100_000;

/**
 * The token budget of a managed job: the workspace's budget, cut down to the context window of the entry's model when
 * the window is known (the user cannot know it: the model is not theirs to see), else to `UNKNOWN_WINDOW_MAX_TOKENS`.
 * Never below what a runner accepts.
 */
export function clampMaxTokens(
  maxTokens: number,
  contextWindow: number | null,
): number {
  const ceiling = contextWindow ?? UNKNOWN_WINDOW_MAX_TOKENS;
  if (maxTokens <= ceiling) return maxTokens;
  return Math.max(ceiling, MIN_BUDGET);
}
