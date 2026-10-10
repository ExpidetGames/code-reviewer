// Where the per-repository options of a job come from: the review settings of its project (CR-25,
// `review-settings-job-options.ts`). The claim asks once per job, so the options can differ per
// repository: the extra options of the four PR-Agent tools (`env`) and the model and the token budget
// of the job.
import type { Job } from "../jobs/job-types.ts";

export type JobOptions = {
  /**
   * Becomes the `env` of the job. The keys must match `RUNNER_ENV_KEY_PATTERN` (the options of the
   * four tools); anything else ends the job as `job_env_invalid`, because the runner would refuse it.
   */
  env: Record<string, string>;
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
};

export type JobOptionsSource = {
  optionsFor(job: Job): Promise<JobOptions>;
};

/** For tests that are not about settings: no extra options, the job gets the LLM access as it is. */
export const emptyJobOptionsSource: JobOptionsSource = {
  optionsFor: async () => ({ env: {} }),
};
