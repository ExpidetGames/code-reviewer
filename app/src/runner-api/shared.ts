// The wiring of the runner API on the running server: the real database, queue, registry and
// settings from the environment. This is the one place that decides which claim guard and which
// source of job options are used (see README.md for what replaces them when the projects land).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getJobQueue } from "../jobs/shared.ts";
import { loadLlmAccess } from "../llm/config.ts";
import { createRunnerApi, type RunnerApi } from "./api.ts";
import { allowAllClaimGuard } from "./claim-guard.ts";
import { HEARTBEAT_INTERVAL_SECONDS } from "./contract.ts";
import { emptyJobEnvSource } from "./job-env.ts";
import { consoleRunnerApiLogger } from "./logger.ts";

/** The exact secrets the app holds, which a stored result must never contain. */
function knownSecrets(): string[] {
  return [process.env.LLM_API_KEY, process.env.RUNNER_TOKEN].filter(
    (value): value is string => value !== undefined,
  );
}

/** The runner API of the running server. */
export function getRunnerApi(): RunnerApi {
  const db = getDatabase();
  return createRunnerApi({
    queue: getJobQueue(),
    repositories: createRepositoriesRepository(db),
    integrations: createIntegrationsRepository(db),
    registry: integrationRegistry,
    // Until the projects exist on this branch, every job may run; see claim-guard.ts.
    guard: allowAllClaimGuard,
    // Until the project settings exist on this branch, a job has no extra options; see job-env.ts.
    jobEnv: emptyJobEnvSource,
    loadLlm: () => loadLlmAccess(process.env),
    now: () => new Date(),
    logger: consoleRunnerApiLogger,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    runnerToken: () => process.env.RUNNER_TOKEN,
    knownSecrets,
  });
}
