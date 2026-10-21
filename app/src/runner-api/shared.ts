// SPDX-License-Identifier: Apache-2.0

// The wiring of the runner API on the running server: the real database, queue, registry and
// settings from the environment. This is the one place that decides which claim guard and which
// source of job options are used (see README.md for what replaces them when the projects land).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { builtInProjectDynamicSettings } from "../review-settings/settings.ts";
import { managedModelsOf } from "./managed-models.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { jobEnded, touched } from "../dispatch/maintenance-shared.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { getWorkspaceLlm, modelCapabilities } from "../llm/shared.ts";
import { getNativeCost } from "../native-cost/shared.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { reviewSettingsServiceFor } from "../review-settings/shared.ts";
import { noteDispatcherClaim } from "../billing/dispatcher-features.ts";
import { createRunnerApi, type RunnerApi } from "./api.ts";
import { APP_VERSION } from "./app-version.ts";
import {
  createWorkerApi,
  type WorkerApi,
  type WorkerApiDeps,
} from "./worker-api.ts";
import { createClaimedKeys, type ClaimedKeys } from "./claimed-keys.ts";
import { createProjectClaimGuard } from "./project-claim-guard.ts";
import { HEARTBEAT_INTERVAL_SECONDS } from "./contract.ts";
import { createReviewSettingsJobOptionsSource } from "./review-settings-job-options.ts";
import { consoleRunnerApiLogger, describeError } from "./logger.ts";
import { createKnownSecrets } from "./known-secrets.ts";
import { errorResponse } from "./responses.ts";
import { configuredRunnerToken } from "./token-auth.ts";

// The key each job was handed lives in the database (encrypted), so any app instance can mask a result.
function getClaimedKeys(): ClaimedKeys {
  return createClaimedKeys({
    db: getDatabase(),
    appSecret: () => {
      const resolved = resolveAppSecret(process.env);
      // The server does not start without it (src/auth/startup.ts); this is the second line.
      if (!resolved.ok) throw new Error(resolved.problem);
      return resolved.secret;
    },
  });
}

/**
 * The collaborators both APIs share: the runner API (claim, heartbeat, complete) and the Worker API
 * (#320, details, heartbeat, result) are two doors to the same queue, checks and redaction.
 */
function sharedDeps(): WorkerApiDeps {
  const db = getDatabase();
  // #432: the model catalog. A claim reads it for a workspace on the operator's key only (an entry and the instance
  // defaults), and the masking of a result reads the model ids of every entry. The claim never writes it.
  const catalog = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
    logger: { info: (line) => console.info(line) },
  });
  const llm = getWorkspaceLlm();
  const nativeCost = getNativeCost();
  return {
    // Runners serve the whole instance: the queue is not scoped, and everything the claim looks up
    // for a job is looked up in the job's own workspace.
    queue: getRunnerQueue(),
    repositories: (workspaceId) =>
      createRepositoriesRepository(db, workspaceId),
    integrations: (workspaceId) =>
      createIntegrationsRepository(db, workspaceId),
    // #199: the exact head of the last successful Dynamic review of the job's pull request; the
    // lookup is scoped to the job's own workspace.
    previousReviewedSha: (job) =>
      createJobsRepository(db, job.workspaceId).previousReviewedSha({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        reviewKind: job.reviewKind,
        excludeJobId: job.id,
      }),
    // #255: the heads of its earlier jobs that did not succeed, which may have written the summary.
    attemptedShas: (job) =>
      createJobsRepository(db, job.workspaceId).attemptedShas({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        reviewKind: job.reviewKind,
        excludeJobId: job.id,
      }),
    registry: integrationRegistry,
    // A job runs only while its repository has an active project; see claim-guard.ts.
    guard: createProjectClaimGuard({ projects: projectServiceFor }),
    // The review settings of the project over the global defaults; see job-options.ts.
    jobOptions: createReviewSettingsJobOptionsSource({
      settings: reviewSettingsServiceFor,
    }),
    // The key the selection of the claimed job names, of the job's own workspace: its own key of the selected provider, or
    // the operator's key of it, never another workspace's and never the other key (src/llm).
    keyFor: (workspaceId, selection) => llm.keyFor(workspaceId, selection),
    // The standing of the job's workspace, asked by the Worker's fetch before it hands out a key (#276).
    entitlementsFor: (workspaceId) =>
      readEffectiveEntitlements(db, workspaceId),
    // Whose key the job runs on, in its usage record; scoped to the job's own workspace.
    recordKeyMode: (job, keyMode) =>
      createUsageRecordsRepository(db, job.workspaceId).setKeyMode(
        job.id,
        keyMode,
      ),
    // #432: the provider and the catalog entry of the job (id and name as they are now), in its usage record; never the model.
    recordSelection: (job, selection) =>
      createUsageRecordsRepository(db, job.workspaceId).setSelection(job.id, {
        provider: selection.provider,
        catalogEntry:
          selection.keyMode === "managed"
            ? { id: selection.entry.id, name: selection.entry.name }
            : null,
      }),
    catalog,
    // The model of a kind when no layer sets one: read for every claim, so a changed LLM_MODEL reaches the next job.
    builtInModel: (kind) =>
      kind === "diff"
        ? configuredLlmModel(process.env)
        : builtInProjectDynamicSettings().dynamicModel,
    // Whether the job ran on the operator's key, and every model id of the catalog, for masking the result.
    managedModels: managedModelsOf({
      usage: (job) =>
        createUsageRecordsRepository(db, job.workspaceId).get(job.id),
      catalog,
    }),
    // #279: the metadata of a job's model (Dynamic, and a managed entry's), read when its claim is built.
    modelCapabilities,
    // #553: the cost policy and the entry of a native job. A provider outside the registry (#555) is always native, there is no
    // legacy wire for it; the two registry providers are native only while the switch of the native path is on (#578).
    nativeCost,
    claimedKeys: getClaimedKeys(),
    // #395: what happens between two sweeps. Both run after the response and do nothing in poll mode.
    jobEnded,
    activity: () => touched(),
    now: () => new Date(),
    logger: consoleRunnerApiLogger,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    // The runner token and the current LLM key of the job's workspace (the key of the claim is in the database).
    // Fails closed (known-secrets.ts): a key that cannot be read fails the completion instead of masking less.
    knownSecrets: createKnownSecrets({
      env: process.env,
      currentKeysFor: (workspaceId) => llm.currentKeysFor(workspaceId),
    }),
  };
}

/** The runner API of the running server. */
export function getRunnerApi(): RunnerApi {
  return createRunnerApi({
    ...sharedDeps(),
    // #493: where a Dispatcher says it created the VM of a claim; scoped to the job's own workspace. The Worker API has
    // no such call.
    vmRuns: (workspaceId) =>
      createJobVmRunsRepository(getDatabase(), workspaceId),
    runnerToken: () => configuredRunnerToken(process.env),
    appVersion: APP_VERSION,
    // #498: which Dispatchers this app serves (billing is not switched on over one that reports no VMs).
    noteClaimFeatures: (features) =>
      noteDispatcherClaim(getDatabase(), features),
  });
}

/** The Worker API of the running server (#320). It has no use for `RUNNER_TOKEN`: a per-job credential opens it. */
export function getWorkerApi(): WorkerApi {
  return createWorkerApi(sharedDeps());
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

/** What the Worker API's route files call; the same kind of answer as `withRunnerApi` if it cannot be set up. */
export async function withWorkerApi(
  call: (api: WorkerApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await call(getWorkerApi());
  } catch (error) {
    consoleRunnerApiLogger.error(
      `[worker-api] the API could not be set up: ${describeError(error)}`,
    );
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }
}
