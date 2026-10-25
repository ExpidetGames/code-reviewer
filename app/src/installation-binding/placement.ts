// SPDX-License-Identifier: LicenseRef-Proprietary

// Where an installation that is new to the instance may go WITHOUT a person binding it (docs/decisions/0001-
// editions-setup-and-accounts.md, section 2.9). Asked by the synchronization and by the webhook route for an
// installation that has no connection yet. The answer is a workspace in exactly one case, and null (the
// installation is noted as unclaimed) in every other:
//
// - single-tenant instance, and
// - the GitHub App is private (it can only be installed on its own account; the admin said so, GitHub's API
//   does not report it), and
// - the installation is on the App's own account (the owner of the App as GitHub reports it),
//
// and then it is the one workspace of the instance. A multi-tenant instance never attaches: any account may
// install a public App, and the installation says nothing about who in which workspace administers it. An
// instance that is not set up has no tenancy yet, so nothing is attached. Anything that cannot be established
// (the owner is not reported, the flag is not known) is "no": fail closed.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type { DiscoveredConnection } from "../integrations/types.ts";

export type ConnectionPlacementOptions = {
  db: Kysely<Database>;
  /** The GitHub App's own account (`provider.ownerAccount`), or null when the platform does not say. */
  ownerAccount: () => Promise<{ externalId: string; login: string } | null>;
  /** The "private app" flag the admin saved: true only when it was said to be true. */
  privateApp: () => Promise<boolean>;
  now?: () => Date;
};

/**
 * How long the App's own account is remembered: one synchronization asks about every new installation in a
 * row, and `GET /app` answers the same to all of them. Short, so a changed App is seen by the next one.
 */
export const OWNER_CACHE_MS = 30_000;

export function createConnectionPlacement({
  db,
  ownerAccount,
  privateApp,
  now = () => new Date(),
}: ConnectionPlacementOptions): (
  connection: DiscoveredConnection,
) => Promise<string | null> {
  let remembered:
    { until: number; owner: ReturnType<typeof ownerAccount> } | undefined;
  function owned(): ReturnType<typeof ownerAccount> {
    const at = now().getTime();
    if (remembered !== undefined && at < remembered.until)
      return remembered.owner;
    const owner = ownerAccount();
    remembered = { until: at + OWNER_CACHE_MS, owner };
    // A failed answer is not remembered: the next installation asks again.
    owner.catch(() => {
      if (remembered?.owner === owner) remembered = undefined;
    });
    return owner;
  }

  return async (connection) => {
    const tenancy = await createInstanceSettingsRepository(db).get("tenancy");
    if (tenancy !== "single") return null;
    if (!(await privateApp())) return null;

    const accountId = connection.config.accountId;
    if (typeof accountId !== "number") return null;
    const owner = await owned();
    if (owner === null || owner.externalId !== String(accountId)) return null;

    const workspace = await createWorkspacesRepository(db).findDefault();
    return workspace?.id ?? null;
  };
}
