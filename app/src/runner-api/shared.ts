// The wiring of the runner API on the running server: the real database, queue, registry and
// settings from the environment. This is the one place that decides which claim guard and which
// source of job options are used (see README.md for what replaces them when the projects land).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import { getLlmAccess } from "../llm/shared.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { reviewSettingsServiceFor } from "../review-settings/shared.ts";
import { createRunnerApi, type RunnerApi } from "./api.ts";
import { createClaimedKeys, type ClaimedKeys } from "./claimed-keys.ts";
import { createProjectClaimGuard } from "./project-claim-guard.ts";
import { HEARTBEAT_INTERVAL_SECONDS } from "./contract.ts";
import { createReviewSettingsJobOptionsSource } from "./review-settings-job-options.ts";
import { consoleRunnerApiLogger, describeError } from "./logger.ts";
import { knownSecretsFromEnv } from "./redact.ts";
import { errorResponse } from "./responses.ts";
import { configuredRunnerToken } from "./token-auth.ts";

// One list for the whole process, kept on globalThis because the route files may be bundled apart.
const CLAIMED_KEYS = Symbol.for("code-reviewer.runner-api.claimed-keys");

function getClaimedKeys(): ClaimedKeys {
  const holder = globalThis as { [CLAIMED_KEYS]?: ClaimedKeys };
  holder[CLAIMED_KEYS] ??= createClaimedKeys();
  return holder[CLAIMED_KEYS];
}

/** The runner API of the running server. */
export function getRunnerApi(): RunnerApi {
  const db = getDatabase();
  return createRunnerApi({
    // Runners serve the whole instance: the queue is not scoped, and everything the claim looks up
    // for a job is looked up in the job's own workspace.
    queue: getRunnerQueue(),
    repositories: (workspaceId) =>
      createRepositoriesRepository(db, workspaceId),
    integrations: (workspaceId) =>
      createIntegrationsRepository(db, workspaceId),
    registry: integrationRegistry,
    // A job runs only while its repository has an active project; see claim-guard.ts.
    guard: createProjectClaimGuard({ projects: projectServiceFor }),
    // The review settings of the project over the global defaults; see job-options.ts.
    jobOptions: createReviewSettingsJobOptionsSource({
      settings: reviewSettingsServiceFor,
    }),
    // The shared LLM configuration, read from the environment on every claim (src/llm).
    loadLlm: () => getLlmAccess(),
    claimedKeys: getClaimedKeys(),
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
