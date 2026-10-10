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
import { emptyJobOptionsSource } from "./job-options.ts";
import { consoleRunnerApiLogger, describeError } from "./logger.ts";
import { knownSecretsFromEnv } from "./redact.ts";
import { errorResponse } from "./responses.ts";
import { configuredRunnerToken } from "./token-auth.ts";

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
    // Until the project settings exist on this branch, a job has no extra options; see job-options.ts.
    jobOptions: emptyJobOptionsSource,
    loadLlm: () => loadLlmAccess(process.env),
    now: () => new Date(),
    logger: consoleRunnerApiLogger,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    runnerToken: () => configuredRunnerToken(process.env),
    knownSecrets: () => knownSecretsFromEnv(process.env),
  });
}

/**
 * What the route files call: builds the API and runs one call. If building it fails (the database
 * was not opened, say), the caller gets the same kind of answer as for any other unplanned failure,
 * with `no-store` and an error body, and the log gets the cause.
 */
export async function withRunnerApi(
  call: (api: RunnerApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await call(getRunnerApi());
  } catch (error) {
    consoleRunnerApiLogger.error(
      `[runner-api] the API could not be set up: ${describeError(error)}`,
    );
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }
}
