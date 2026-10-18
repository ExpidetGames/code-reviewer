// SPDX-License-Identifier: Apache-2.0

// Where the per-repository options of a job come from: the review settings of its project (CR-25,
// `review-settings-job-options.ts`). The claim asks once per job, so the options can differ per
// repository: the extra options of the four PR-Agent tools (`env`) and the model and the token budget
// of the job.
import type { Job } from "../jobs/job-types.ts";
import type { ModelLayer } from "../llm/selection.ts";

export type JobOptions = {
  /**
   * Becomes the `env` of the job. The keys must match `RUNNER_ENV_KEY_PATTERN` (the options of the
   * four tools); anything else ends the job as `job_env_invalid`, because the runner would refuse it.
   */
  env: Record<string, string>;
  /**
   * #432: what the claim chooses provider, model and catalog entry from (`resolveModelSelection`), for the job's pinned
   * kind. `layers` are the settings that wrote a provider or a model (own key), `entryId` is the catalog entry the project
   * selected (operator's key). Left out by a source that does not know them: the claim then reads `llm.model` (or
   * `dynamic.model`) as one project layer for the default provider.
   */
  selection?: {
    layers: { workspace?: ModelLayer; project?: ModelLayer };
    entryId: string | null;
  };
  llm?: {
    /** Replaces the model of the LLM access for this job. Null or left out: keep it. */
    model?: string | null;
    /** `llm.maxTokens` of the job (a whole number of 1000 to 10 000 000). Null or left out: not sent. */
    maxTokens?: number | null;
    /**
     * The fallback models, in order. Accepted here and not handed on: the MVP has no fallback chain
     * (the contract has the field, `llm.fallbackModels`, for when one is decided).
     */
    fallbackModels?: readonly string[];
  };
  /**
   * #195: the Dynamic options of a job whose project runs Dynamic Review. Present only then; a Diff
   * job leaves it out so it gets the exact legacy payload. Model, skill and the output limit only.
   */
  dynamic?: {
    model: string;
    skill: string;
    maxFindings: number;
  };
};

export type JobOptionsSource = {
  optionsFor(job: Job): Promise<JobOptions>;
};

/** For tests that are not about settings: no extra options, the job gets the LLM access as it is. */
export const emptyJobOptionsSource: JobOptionsSource = {
  optionsFor: async () => ({ env: {} }),
};
