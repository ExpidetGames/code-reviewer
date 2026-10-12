// SPDX-License-Identifier: Apache-2.0

// What it means to link an installation to a workspace, and to end that: the one place that creates, brings
// back and disconnects a connection for the binding (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.9). It does NOT decide whether somebody may link: the callers do (the checks with the person's token in
// service.ts, the instance admin's approval in approvals.ts) and only call `link` when they are satisfied.
//
// - `link` asks GitHub with the App's own credentials what the installation is (no workspace is told anything
//   the person's token has not shown), then, in one transaction, creates the connection or recognizes the one
//   that is there: an installation belongs to ONE workspace (the unique index of `integrations`), so another
//   workspace's installation is refused with one answer that does not say whose it is. Linking it again from
//   the same workspace is idempotent, and brings back a connection that was disconnected. Afterwards the
//   installation is no longer unclaimed, the requests for it (of every workspace) are withdrawn and its
//   repositories are read.
// - `disconnect` turns the connection into `disconnected` and its repositories inactive in one transaction.
//   The row stays (so the installation stays the workspace's, projects and runs keep their reference), the
//   synchronization never resumes it, and nothing happens on GitHub.
//
// Both run inside the keyed lock of the synchronization, so a read of the installation's repositories never
// interleaves with them: a sync that began before a disconnect cannot write its repositories back.
import type { Kysely } from "kysely";
import { createIntegrationDirectory } from "../db/repositories/integration-directory-repository.ts";
import { createInstallationLinkRequestDirectory } from "../db/repositories/installation-link-request-directory-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import type { Database } from "../db/schema.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import {
  defaultKeyedLock,
  type KeyedLock,
} from "../integrations/sync/keyed-lock.ts";
import type { BindingErrorCode } from "./errors.ts";

const TYPE = "github_app" as const;

export type LinkInput = {
  workspaceId: string;
  /** The installation id as text. */
  installationId: string;
  /**
   * Runs inside the transaction before anything is linked, and answers whether to go on (false: nothing is
   * linked, the answer is `not_claimed`). The approval of the instance admin uses it to claim the decision of
   * the request, so a request is decided once and its link is made with the decision or not at all.
   */
  claim?: (trx: Kysely<Database>) => Promise<boolean>;
};

export type LinkResult =
  | {
      ok: true;
      integrationId: string;
      outcome: "created" | "reconnected" | "already_linked";
      /** The status the connection has now: `disabled` for an installation GitHub has suspended. */
      status: "active" | "disabled";
    }
  | {
      ok: false;
      error: Extract<
        BindingErrorCode,
        | "installation_already_linked"
        | "installation_not_accessible"
        | "github_unreachable"
        | "unavailable"
      >;
    }
  | { ok: false; error: "not_claimed" };

export type DisconnectResult =
  { ok: true } | { ok: false; error: "integration_not_found" };

export type Connections = {
  link(input: LinkInput): Promise<LinkResult>;
  disconnect(input: {
    workspaceId: string;
    integrationId: string;
  }): Promise<DisconnectResult>;
};

export type ConnectionsOptions = {
  db: Kysely<Database>;
  registry: IntegrationRegistry;
  sync: Pick<IntegrationSyncService, "syncIntegration">;
  lock?: KeyedLock;
  now?: () => Date;
  log?: (line: string) => void;
};

class NotClaimed extends Error {}
class OtherWorkspace extends Error {}

export function createConnections({
  db,
  registry,
  sync,
  lock = defaultKeyedLock(db),
  now,
  log = (line) => console.error(line),
}: ConnectionsOptions): Connections {
  const lockKey = (installationId: string) => `${TYPE}:${installationId}`;

  async function linkWithinLock(
    workspaceId: string,
    installationId: string,
    claim: LinkInput["claim"],
  ): Promise<LinkResult> {
    const provider = registry.resolve(TYPE);
    let connection;
    try {
      connection = await provider.findConnection?.(installationId);
    } catch {
      return { ok: false, error: "github_unreachable" };
    }
    if (connection === undefined || connection === null)
      return { ok: false, error: "installation_not_accessible" };
    const validated = provider.validateConfig(connection.config);
    if (!validated.ok) return { ok: false, error: "unavailable" };
    const status = connection.suspended ? "disabled" : "active";

    let linked: {
      integrationId: string;
      outcome: "created" | "reconnected" | "already_linked";
    };
    try {
      linked = await db.transaction().execute(async (trx) => {
        if (claim !== undefined && !(await claim(trx))) throw new NotClaimed();
        const existing = await createIntegrationDirectory(trx).findByExternalId(
          TYPE,
          installationId,
        );
        if (existing !== undefined) {
          if (existing.workspaceId !== workspaceId) throw new OtherWorkspace();
          if (existing.status === "disconnected") {
            await createIntegrationsRepository(trx, workspaceId, now).setStatus(
              existing.id,
              status,
            );
            return { integrationId: existing.id, outcome: "reconnected" };
          }
          return { integrationId: existing.id, outcome: "already_linked" };
        }
        const created = await createIntegrationsRepository(
          trx,
          workspaceId,
          now,
        ).create({
          type: TYPE,
          displayName: connection.displayName,
          externalId: connection.externalId,
          config: validated.config,
          status,
        });
        return { integrationId: created.id, outcome: "created" };
      });
    } catch (error) {
      if (error instanceof NotClaimed)
        return { ok: false, error: "not_claimed" };
      // Another workspace has it, or won the race to link it: the unique index decides.
      if (
        error instanceof OtherWorkspace ||
        (error instanceof IntegrationError &&
          error.code === "INTEGRATION_ALREADY_EXISTS")
      )
        return { ok: false, error: "installation_already_linked" };
      log("[installation-binding] LINK_FAILED: the connection was not made.");
      return { ok: false, error: "unavailable" };
    }

    await createUnclaimedInstallationsRepository(db, now).forget(
      installationId,
    );
    // Requests of any workspace for it end here: the one that was approved is decided already, the others (of
    // this workspace and of workspaces that asked for the same installation) can never be approved now.
    await createInstallationLinkRequestDirectory(db, now).withdrawPendingFor(
      installationId,
    );
    return { ok: true, ...linked, status };
  }

  return {
    async link({ workspaceId, installationId, claim }) {
      const linked = await lock.run(
        lockKey(installationId),
        (): Promise<LinkResult> =>
          linkWithinLock(workspaceId, installationId, claim),
      );
      // The repositories of a connection that is new or back are read now, outside the lock (the synchronization
      // takes it itself); a suspended connection has none to read.
      if (
        linked.ok &&
        linked.outcome !== "already_linked" &&
        linked.status === "active"
      ) {
        try {
          const summary = await sync.syncIntegration(linked.integrationId);
          for (const failure of summary.errors)
            log(
              `[installation-binding] the repositories of the new connection could not be read (${failure.code}).`,
            );
        } catch {
          log(
            "[installation-binding] the repositories of the new connection could not be read.",
          );
        }
      }
      return linked;
    },

    async disconnect({ workspaceId, integrationId }) {
      const own = await createIntegrationsRepository(db, workspaceId, now).get(
        integrationId,
      );
      if (own === undefined)
        return { ok: false, error: "integration_not_found" };
      return lock.run(lockKey(own.externalId), async () => {
        await db.transaction().execute(async (trx) => {
          const integrations = createIntegrationsRepository(
            trx,
            workspaceId,
            now,
          );
          if (
            (await integrations.get(integrationId))?.status !== "disconnected"
          )
            await integrations.setStatus(integrationId, "disconnected");
          await createRepositoriesRepository(
            trx,
            workspaceId,
            now,
          ).deactivateAll(integrationId);
        });
        return { ok: true } as const;
      });
    },
  };
}
