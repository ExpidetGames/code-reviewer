// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/repository-sync: the daily sync with GitHub, called by the platform's cron in
// serverless mode (404 anywhere else). Public for the session guard: CRON_SECRET is the credential.
// All logic is in src/cron/.
import { connection } from "next/server";
import { handleRepositorySyncCron } from "../../../../cron/repository-sync.ts";
import { getGithubCredentialStore } from "../../../../github-config/shared.ts";
import { getIntegrationSync } from "../../../../integrations/sync/shared.ts";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleRepositorySyncCron(request, {
    env: process.env,
    githubConfigured: async () =>
      (await getGithubCredentialStore().load()).source !== "none",
    syncAll: () => getIntegrationSync().syncAll(),
  });
}
