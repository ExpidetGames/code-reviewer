// SPDX-License-Identifier: Apache-2.0

// The check run service (#405) over what it really runs on: a migrated database with the job queue fixture, the real
// GitHub App provider and client over HTTP against the fake GitHub (which serves the Checks and review API), and a
// clock the test moves. A test enqueues, claims and completes jobs through `queue`, calls the service like the
// running server does (`syncJob`, `reconcileDue`) and reads what the fake GitHub shows.
import { createCheckRunService } from "../check-runs/service.ts";
import type { CheckRunService } from "../check-runs/service.ts";
import { createJobCheckRunsRepository } from "../db/repositories/job-check-runs-repository.ts";
import { listJobsWithCheckWork } from "../db/repositories/job-check-runs-sweep.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Job } from "../jobs/job-types.ts";
import type { ClaimOptions } from "../db/repositories/runner-jobs-repository.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import { createIntegrationRegistry } from "../integrations/registry.ts";
import { loadGithubAppConfig } from "../integrations/providers/github-app/config.ts";
import { createGithubAppProvider } from "../integrations/providers/github-app/provider.ts";
import {
  DEFAULT_REVIEW_VERDICT_MODE,
  type ReviewVerdictMode,
} from "../review-settings/settings.ts";
import { startGithubAppHarness } from "./github-app-harness.ts";
import { TEST_APP_SLUG } from "./github-app.ts";
import { createJobQueueFixture, sha, type JobQueueFixture } from "./jobs.ts";

export const HEAD = sha("a");
export const COMMENT_URL =
  "https://github.test/acme/widgets/pull/7#issuecomment-1001";

export type CheckRunsHarness = {
  fixture: JobQueueFixture;
  /** The repository the fixture's jobs belong to ("owner/name"), and its id on GitHub. */
  repo: string;
  repoId: number;
  fake: Awaited<ReturnType<typeof startGithubAppHarness>>["fake"];
  service: CheckRunService;
  lines: { info: string[]; error: string[] };
  /** The verdict mode the project has; the test changes it like a settings save would. */
  setVerdictMode(mode: ReviewVerdictMode): void;
  /** The state of the job's row, as stored. */
  rowOf(
    jobId: string,
  ): ReturnType<ReturnType<typeof createJobCheckRunsRepository>["find"]>;
  /** Claims the next job as a runner and returns it with its lease token. */
  claim(options?: ClaimOptions): Promise<{ job: Job; token: string }>;
  /** The provider the service uses, and the integration and repository of the fixture, for a test that writes to GitHub itself. */
  provider: IntegrationProvider;
  target(): Promise<{ integration: Integration; repo: RepoRef }>;
  /** Completes a claimed job with a successful result. */
  succeed(
    job: Job,
    token: string,
    result?: Record<string, unknown>,
  ): Promise<void>;
  /** Completes a claimed job with a failure. */
  fail(job: Job, token: string, errorCode: string): Promise<void>;
  /** The check runs of the repository, oldest first. */
  checkRuns(): ReturnType<
    Awaited<ReturnType<typeof startGithubAppHarness>>["fake"]["checkRuns"]
  >;
  /** The reviews of pull request 7. */
  reviews(): ReturnType<
    Awaited<
      ReturnType<typeof startGithubAppHarness>
    >["fake"]["pullRequestReviews"]
  >;
};

export async function createCheckRunsHarness(
  options: { permissions?: Record<string, "read" | "write"> } = {},
): Promise<CheckRunsHarness> {
  const fixture = await createJobQueueFixture();
  // The repository the jobs of the fixture belong to, as GitHub knows it.
  const repository = (
    await createRepositoriesRepository(fixture.db, fixture.workspaceId).list()
  ).find((item) => item.id === fixture.repositoryId);
  if (repository === undefined)
    throw new Error("The fixture has no repository.");
  const repo = repository.fullName;
  const repoId = Number(repository.externalId);
  const github = await startGithubAppHarness({ appSlug: TEST_APP_SLUG });
  const { fake } = github;
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  fake.addPullRequest(repo, {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  if (options.permissions !== undefined)
    fake.setAppPermissions(options.permissions);

  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(github.env),
    clientOptions: { now: github.clock.now },
  });
  let verdictMode: ReviewVerdictMode = DEFAULT_REVIEW_VERDICT_MODE;
  const lines = { info: [] as string[], error: [] as string[] };
  const { db, workspaceId } = fixture;
  const checks = createJobCheckRunsRepository(
    db,
    workspaceId,
    fixture.clock.now,
  );
  const service = createCheckRunService({
    jobs: { get: (id) => fixture.queue.get(id) },
    repositories: (id) =>
      createRepositoriesRepository(db, id, fixture.clock.now),
    integrations: (id) =>
      createIntegrationsRepository(db, id, fixture.clock.now),
    checks: (id) => createJobCheckRunsRepository(db, id, fixture.clock.now),
    dueJobs: (at, limits) => listJobsWithCheckWork(db, at, limits),
    verdictMode: async () => verdictMode,
    registry: createIntegrationRegistry({ github_app: provider }),
    now: fixture.clock.now,
    log: {
      info: (line) => lines.info.push(line),
      error: (line) => lines.error.push(line),
    },
  });

  return {
    fixture,
    repo,
    repoId,
    fake,
    service,
    lines,
    setVerdictMode(mode) {
      verdictMode = mode;
    },
    rowOf: (jobId) => checks.find(jobId),
    provider,
    async target() {
      const integration = (
        await createIntegrationsRepository(db, workspaceId).list()
      )[0];
      const repository = (
        await createRepositoriesRepository(db, workspaceId).list()
      ).find((item) => item.fullName === repo);
      if (integration === undefined || repository === undefined)
        throw new Error("The fixture has no integration.");
      return {
        integration,
        repo: {
          integrationId: repository.integrationId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          url: repository.url,
        },
      };
    },
    async claim(claimOptions) {
      const claimed = await fixture.queue.claimNext(
        "runner-1",
        undefined,
        claimOptions,
      );
      if (claimed === null) throw new Error("Nothing to claim.");
      return { job: claimed.job, token: claimed.leaseToken };
    },
    async succeed(job, token, result = {}) {
      await fixture.queue.complete(job.id, token, {
        ok: true,
        result: { ok: true, commentUrl: COMMENT_URL, ...result } as never,
      });
    },
    async fail(job, token, errorCode) {
      await fixture.queue.complete(job.id, token, {
        ok: false,
        errorCode,
        result: { ok: false, errorCode } as never,
      });
    },
    checkRuns: () => fake.checkRuns(repo),
    reviews: () => fake.pullRequestReviews(repo, 7),
  };
}
