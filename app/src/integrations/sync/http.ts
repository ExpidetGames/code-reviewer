// SPDX-License-Identifier: LicenseRef-Proprietary

// The handler behind `POST /api/integrations/sync`, the "Sync from GitHub" button. It runs the
// process-wide sync (src/integrations/README.md, "Synchronization") and answers with how many
// repositories are new and what went wrong at GitHub. The collaborators are passed in so the route
// file only wires the real ones and tests wire fakes.
//
// Order: the user first (nothing is called before the caller is known), then where the request comes
// from, then the sync. The sync never rejects because of GitHub; its failures are in `errors`
// (stage and stable code, never a credential).
import type { SessionUser } from "../../auth/access-policy.ts";
import { isCrossSite } from "../../http/request-checks.ts";
import type { SyncErrorCode } from "./errors.ts";
import type { IntegrationSyncService, SyncError } from "./service.ts";

export type SyncRouteDependencies = {
  /**
   * The signed in user, or a throw that ends the request (`requireUser()` redirects to the login
   * page). Called first, on every request.
   */
  requireUser: () => Promise<SessionUser>;
  sync: Pick<IntegrationSyncService, "syncAll">;
};

/** What the button gets back. */
export type SyncAnswer = {
  /** Repositories GitHub lists that this instance did not know yet. */
  added: number;
  errors: SyncError[];
};

const NO_STORE = { "cache-control": "no-store" };

export function createSyncRouteHandler({
  requireUser,
  sync,
}: SyncRouteDependencies): (request: Request) => Promise<Response> {
  return async function handle(request) {
    await requireUser();
    if (isCrossSite(request))
      return Response.json(
        { error: "SYNC_CROSS_SITE_REQUEST" satisfies SyncErrorCode },
        { status: 403, headers: NO_STORE },
      );
    const summary = await sync.syncAll();
    const answer: SyncAnswer = {
      added: summary.repositories.added,
      errors: summary.errors,
    };
    return Response.json(answer, { headers: NO_STORE });
  };
}
