// The job options of the running server: the review settings of the job's repository, the project's
// overrides over the global defaults over the built-in values (CR-25), turned into the fields of a job
// by `toRunnerSettings`. The claim asks once per job, so a change of the settings reaches the next
// job that is claimed, not only the next one that is queued.
import type { ReviewSettingsService } from "../review-settings/service.ts";
import { toRunnerSettings } from "../review-settings/runner-settings.ts";
import type { JobOptionsSource } from "./job-options.ts";

export function createReviewSettingsJobOptionsSource(deps: {
  settings: Pick<ReviewSettingsService, "resolveForRepository">;
}): JobOptionsSource {
  return {
    async optionsFor(job) {
      const resolved = await deps.settings.resolveForRepository(
        job.repositoryId,
      );
      // No project: the claim guard refuses such a job before it asks for options, so this is a job
      // that raced with a deletion. No options is the safe answer (the runner's defaults apply).
      if (resolved === undefined) return { env: {} };
      const { llm, env, fallbackModels } = toRunnerSettings(resolved.settings);
      return { env, llm: { ...llm, fallbackModels } };
    },
  };
}
