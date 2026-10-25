// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/repository-sync, called once a day by the platform's cron (`vercel.json`) in
// serverless mode: the full sync with GitHub that a server runs at start. A serverless instance cannot
// do that at start (it would run on every cold start of every instance), and the webhooks only report
// what changed since; the daily run catches whatever a missed webhook left behind. The answer carries
// counts only.
import "server-only";
import type { SyncSummary } from "../integrations/sync/service.ts";
import { refuseUnlessCron } from "./auth.ts";

export const REPOSITORY_SYNC_ERROR_CODES = ["REPOSITORY_SYNC_FAILED"] as const;

type Dependencies = {
  env: Readonly<Record<string, string | undefined>>;
  /** Without a GitHub App the instance is simply not connected yet: nothing is attempted. */
  githubConfigured: () => Promise<boolean>;
  syncAll: () => Promise<SyncSummary>;
};

export async function handleRepositorySyncCron(
  request: Request,
  { env, githubConfigured, syncAll }: Dependencies,
): Promise<Response> {
  const refusal = refuseUnlessCron(request, env);
  if (refusal !== null) return refusal;
  const headers = { "cache-control": "no-store" };
  try {
    if (!(await githubConfigured()))
      return Response.json(
        { status: "skipped", reason: "github_not_configured" },
        { headers },
      );
    const { integrations, repositories, errors } = await syncAll();
    console.info(
      `[integrations] daily sync done: ${String(integrations.created)} integrations created, ` +
        `${String(repositories.added)} repositories added, ${String(repositories.reactivated)} reactivated, ` +
        `${String(repositories.deactivated)} deactivated, ${String(errors.length)} errors`,
    );
    return Response.json(
      {
        status: "ok",
        integrations: { created: integrations.created },
        repositories: {
          added: repositories.added,
          reactivated: repositories.reactivated,
          deactivated: repositories.deactivated,
        },
        errors: errors.length,
      },
      { headers },
    );
  } catch {
    // The cause is not repeated: it may carry a connection string. The platform shows the 500.
    console.error(
      "[integrations] REPOSITORY_SYNC_FAILED: the daily sync could not run.",
    );
    return Response.json(
      { status: "error", code: "REPOSITORY_SYNC_FAILED" },
      { status: 500, headers },
    );
  }
}
