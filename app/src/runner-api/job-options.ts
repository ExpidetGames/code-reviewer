// Where the per-repository options of a job come from: the project settings (CR-25). The claim asks
// once per job, so the options can differ per repository: the extra options of the four PR-Agent tools
// (`env`) and, if the project chose them, the model and the context size of the job. Until the
// settings exist on this branch the source is empty and the job gets the LLM access as it is.
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
     * The fallback models, in order. The job has no field for them yet (the runner pins an empty
     * list), so they are accepted here and not handed on.
     */
    fallbackModels?: readonly string[];
  };
};

export type JobOptionsSource = {
  optionsFor(job: Job): Promise<JobOptions>;
};

/** The source of this branch: no project settings yet, so no extra options. */
export const emptyJobOptionsSource: JobOptionsSource = {
  optionsFor: async () => ({ env: {} }),
};
