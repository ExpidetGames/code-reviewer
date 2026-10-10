// Where the `env` of a job comes from: the options of the four PR-Agent tools that a project sets
// (CR-25). Until the settings exist this is empty. The keys must be of the form the contract
// allows (`PR_REVIEWER__*`, `PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`).
import type { Job } from "../jobs/job-types.ts";

export type JobEnvSource = {
  envFor(job: Job): Promise<Record<string, string>>;
};

/** The source of this branch: no project settings yet, so no extra options. */
export const emptyJobEnvSource: JobEnvSource = {
  envFor: async () => ({}),
};
