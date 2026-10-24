// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the manual start needs: the webhook harness (a real SQLite file, the fake
// GitHub API, the real GitHub App provider), an installation "acme" with the repository
// "acme/widgets" as an active project, a clean fake GitHub, the real review settings service, the
// real job queue and the manual review service wired to all of them.
import type { FakePullRequest } from "../../../fakes/github/server.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createTestQueue } from "./jobs.ts";
import { createManualReviewService } from "../manual-reviews/service.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { startWebhookHarness } from "./webhook-harness.ts";

/** A head commit id. */
export const HEAD_SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

/** An open pull request of "acme/widgets" with this number. */
export function pullRequest(
  number: number,
  overrides: Partial<FakePullRequest> = {},
): FakePullRequest {
  return {
    number,
    title: `Change number ${number}`,
    state: "open",
    headSha: HEAD_SHA,
    headRef: `feature/${number}`,
    baseRef: "main",
    author: { login: "alice", id: 1001 },
    ...overrides,
  };
}

export async function startManualReviewHarness(
  options: { requestTimeoutMs?: number } = {},
) {
  const h = await startWebhookHarness(options);
  const integration = await h.seedInstallation();
  const [repository] = await h.repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined) throw new Error("seeding failed");
  // seedInstallation adds pull request 7; the tests set up their own.
  h.fake.reset();
  h.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

  const settings = createReviewSettingsService({
    appSettings: createAppSettingsRepository(h.db, h.workspaceId),
    projects: createProjectsRepository(h.db, h.workspaceId),
    builtIn: () => builtInReviewSettings("test/model"),
  });
  const queue = createTestQueue(h.db, h.workspaceId);
  const lines: string[] = [];
  const service = createManualReviewService({
    repositories: h.repositories,
    integrations: h.integrations,
    projects: h.projects,
    settings,
    registry: h.registry,
    queue,
    log: (line) => lines.push(line),
  });
  // The reset cost the client its token; one call gets a new one, so no test starts with a refusal.
  await service.listOpenPullRequests(repository.id);
  return { h, repository, integration, service, queue, settings, lines };
}

export type ManualReviewHarness = Awaited<
  ReturnType<typeof startManualReviewHarness>
>;
