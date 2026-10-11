// SPDX-License-Identifier: Apache-2.0

// Keeps the `integrations` and `repositories` tables in line with the platform: which connections
// (GitHub App installations) exist and which repositories each one gives access to.
//
// One rule runs through all of it: a table row is changed to "gone" only after the platform has
// answered completely. A failure (5xx, timeout, refused credentials, a missing page) is reported and
// leaves the rows as they were, so an outage can never deactivate a repository. Nothing is deleted:
// what disappears becomes inactive (a repository) or disabled (an integration).
//
// Triggers: the start of the app, a delivery about an installation (`handleInstallationChange`, which
// the webhook route calls) and a button (`syncAll`). They all end in the same reconciliation against
// the platform's current state, so repeating or overlapping them is harmless.
import "server-only";
import type { Kysely } from "kysely";
import { createIntegrationDirectory } from "../../db/repositories/integration-directory-repository.ts";
import { createIntegrationsRepository } from "../../db/repositories/integrations-repository.ts";
import {
  createRepositoriesRepository,
  type ReconcileResult,
} from "../../db/repositories/repositories-repository.ts";
import type { Database } from "../../db/schema.ts";
import { resolveDefaultWorkspaceId } from "../../workspaces/current-workspace.ts";
import { hasSafeMessage, IntegrationError } from "../errors.ts";
import type { IntegrationProvider } from "../provider.ts";
import type { IntegrationRegistry } from "../registry.ts";
import type {
  DiscoveredConnection,
  InstallationAction,
  Integration,
  IntegrationType,
} from "../types.ts";
import { sharedKeyedLock, type KeyedLock } from "./keyed-lock.ts";

export type SyncError = {
  stage: "discover" | "connection" | "repositories";
  /** The integration the failure belongs to, when there is one. */
  integrationId: string | null;
  /** The stable code of the underlying error. */
  code: string;
  /** Safe to show and log: it names the call and the status, never a credential. */
  message: string;
};

export type SyncSummary = {
  integrations: {
    created: number;
    updated: number;
    enabled: number;
    disabled: number;
  };
  /** Totals over all integrations that were read completely. */
  repositories: ReconcileResult;
  errors: SyncError[];
};

export const INSTALLATION_CHANGE_OUTCOMES = [
  /** A row was created for an installation that GitHub confirmed. */
  "created",
  "synced",
  "disabled",
  /** The integration is disabled and all its repositories are inactive. */
  "deactivated",
  /** The delivery names an installation we have no row for and need none (for example a deletion). */
  "unknown_installation",
  /** GitHub does not know the installation the delivery names: nothing was created. */
  "installation_not_found",
  /** The integration is disabled (suspended), so its repositories are not read. */
  "skipped_disabled",
  /** The platform could not be asked; see `errors`. Nothing was changed. */
  "failed",
] as const;
export type InstallationChangeOutcome =
  (typeof INSTALLATION_CHANGE_OUTCOMES)[number];

export type InstallationChangeResult = {
  outcome: InstallationChangeOutcome;
  summary: SyncSummary;
};

export type IntegrationSyncService = {
  /**
   * Reads every connection and every repository from the platform and reconciles the tables. Never
   * rejects because of the platform: failures are in `errors`.
   */
  syncAll(): Promise<SyncSummary>;
  /** Reads and reconciles the repositories of one integration. */
  syncIntegration(integrationId: string): Promise<SyncSummary>;
  /**
   * Applies a delivery about a connection (`installation_changed` of the provider). For a connection
   * without a row it asks the platform whether it exists before creating one. Never rejects because
   * of the platform.
   */
  handleInstallationChange(change: {
    type: IntegrationType;
    externalId: string;
    action: InstallationAction;
  }): Promise<InstallationChangeResult>;
};

export type IntegrationSyncOptions = {
  db: Kysely<Database>;
  registry: IntegrationRegistry;
  now?: () => Date;
  /**
   * Orders the work on the same installation. Default: the lock shared by the whole process, so that
   * the start-up sync, a webhook and the button never overlap on one installation however many
   * services were created. Pass another only to test the lock itself.
   */
  lock?: KeyedLock;
  /** Receives one line per failure. Default: console.error. */
  log?: (line: string) => void;
  /**
   * The workspace a connection that is new to the instance is put in. TEMPORARY: the default
   * workspace, until the installation of a connection is bound to the workspace of the person who
   * installed it (the workspace feature). Connections that exist keep their workspace.
   */
  workspaceForNewConnection?: () => Promise<string>;
};

function emptySummary(): SyncSummary {
  return {
    integrations: { created: 0, updated: 0, enabled: 0, disabled: 0 },
    repositories: {
      added: 0,
      reactivated: 0,
      updated: 0,
      deactivated: 0,
      unchanged: 0,
    },
    errors: [],
  };
}

function addRepositories(total: ReconcileResult, part: ReconcileResult): void {
  total.added += part.added;
  total.reactivated += part.reactivated;
  total.updated += part.updated;
  total.deactivated += part.deactivated;
  total.unchanged += part.unchanged;
}

function sameDetails(a: Integration, b: DiscoveredConnection): boolean {
  return (
    a.displayName === b.displayName &&
    JSON.stringify(a.config) === JSON.stringify(b.config)
  );
}

export function createIntegrationSync(
  options: IntegrationSyncOptions,
): IntegrationSyncService {
  const { db, registry } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  // The sync walks every connection of the instance. It finds them through the directory, which
  // belongs to no workspace, and changes each one through repositories of the workspace it names.
  const directory = createIntegrationDirectory(db);
  const integrationsOf = (executor: Kysely<Database>, workspaceId: string) =>
    createIntegrationsRepository(executor, workspaceId, options.now);
  const repositoriesOf = (executor: Kysely<Database>, workspaceId: string) =>
    createRepositoriesRepository(executor, workspaceId, options.now);
  const workspaceForNewConnection =
    options.workspaceForNewConnection ?? (() => resolveDefaultWorkspaceId(db));
  const lock = options.lock ?? sharedKeyedLock();
  const lockKey = (type: IntegrationType, externalId: string) =>
    `${type}:${externalId}`;

  function recordFailure(
    summary: SyncSummary,
    stage: SyncError["stage"],
    integrationId: string | null,
    error: unknown,
  ): void {
    // Only an error that carries the safe-message marker has a message known to be free of
    // secrets; anything else is reduced to a generic line.
    const code =
      typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : "INTEGRATION_SYNC_FAILED";
    const message = hasSafeMessage(error)
      ? error.message
      : "The synchronization failed unexpectedly.";
    summary.errors.push({ stage, integrationId, code, message });
    log(
      `[integrations] sync failed (${stage}${integrationId ? ` ${integrationId}` : ""}): ${code}: ${message}`,
    );
  }

  /** Disables the integration and deactivates its repositories in one transaction. */
  async function disableAndDeactivate(
    integration: Integration,
    summary: SyncSummary,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      if (integration.status !== "disabled") {
        await integrationsOf(trx, integration.workspaceId).setStatus(
          integration.id,
          "disabled",
        );
        summary.integrations.disabled += 1;
      }
      const deactivated = await repositoriesOf(
        trx,
        integration.workspaceId,
      ).deactivateAll(integration.id);
      summary.repositories.deactivated += deactivated;
    });
  }

  async function createFromConnection(
    provider: IntegrationProvider,
    connection: DiscoveredConnection,
    summary: SyncSummary,
  ): Promise<Integration | undefined> {
    const validated = provider.validateConfig(connection.config);
    if (!validated.ok)
      throw new IntegrationError(
        "INTEGRATION_CONFIG_INVALID",
        `The platform's description of connection ${connection.externalId} is not a valid config.`,
      );
    try {
      const created = await integrationsOf(
        db,
        await workspaceForNewConnection(),
      ).create({
        type: provider.type,
        displayName: connection.displayName,
        externalId: connection.externalId,
        config: validated.config,
        status: connection.suspended ? "disabled" : "active",
      });
      summary.integrations.created += 1;
      return created;
    } catch (error) {
      // Another sync created it a moment ago.
      if (
        error instanceof IntegrationError &&
        error.code === "INTEGRATION_ALREADY_EXISTS"
      )
        return directory.findByExternalId(provider.type, connection.externalId);
      throw error;
    }
  }

  /**
   * Brings an existing row in line with what the platform says about the connection. A change of
   * status (suspended or not) is first confirmed with the platform unless `confirmed` says the
   * connection was just read: the list it came from may be older than a delivery that already set
   * the row right. Call inside the lock.
   */
  async function applyConnection(
    provider: IntegrationProvider,
    existing: Integration,
    connection: DiscoveredConnection,
    summary: SyncSummary,
    confirmed: boolean,
  ): Promise<Integration> {
    let effective = connection;
    const statusWouldChange =
      (connection.suspended && existing.status === "active") ||
      (!connection.suspended && existing.status === "disabled");
    if (statusWouldChange && !confirmed && provider.findConnection) {
      const fresh = await provider.findConnection(existing.externalId);
      // Gone since the list was read: the "not listed" handling will deal with it.
      if (fresh === null) return existing;
      effective = fresh;
    }

    let current = existing;
    if (!sameDetails(existing, effective)) {
      await integrationsOf(db, existing.workspaceId).updateDetails(
        existing.id,
        {
          displayName: effective.displayName,
          config: effective.config,
        },
      );
      summary.integrations.updated += 1;
    }
    if (effective.suspended && existing.status === "active") {
      await integrationsOf(db, existing.workspaceId).setStatus(
        existing.id,
        "disabled",
      );
      summary.integrations.disabled += 1;
      current = { ...current, status: "disabled" };
    } else if (!effective.suspended && existing.status === "disabled") {
      await integrationsOf(db, existing.workspaceId).setStatus(
        existing.id,
        "active",
      );
      summary.integrations.enabled += 1;
      current = { ...current, status: "active" };
    }
    return current;
  }

  /** Reads all repositories of an active integration and reconciles them. Call inside the lock. */
  async function syncRepositories(
    provider: IntegrationProvider,
    integrationId: string,
    summary: SyncSummary,
  ): Promise<"synced" | "skipped" | "failed"> {
    const integration = await directory.get(integrationId);
    // Re-read inside the lock: a delivery may have disabled it since the list was made.
    if (integration === undefined || integration.status !== "active")
      return "skipped";
    let remote;
    try {
      remote = await provider.listRepositories(integration);
    } catch (error) {
      recordFailure(summary, "repositories", integration.id, error);
      return "failed";
    }
    const own = remote.filter((repo) => repo.integrationId === integration.id);
    addRepositories(
      summary.repositories,
      await repositoriesOf(db, integration.workspaceId).reconcile(
        integration.id,
        own,
      ),
    );
    return "synced";
  }

  async function discoverAndSync(
    provider: IntegrationProvider,
    summary: SyncSummary,
  ): Promise<void> {
    if (provider.discoverConnections === undefined) return;
    let connections: DiscoveredConnection[];
    try {
      connections = await provider.discoverConnections();
    } catch (error) {
      // Not knowing the connections is not the same as having none: change nothing.
      recordFailure(summary, "discover", null, error);
      return;
    }

    const seen = new Set<string>();
    for (const connection of connections) {
      seen.add(connection.externalId);
      await lock.run(
        lockKey(provider.type, connection.externalId),
        async () => {
          let integrationId: string | null = null;
          try {
            const existing = await directory.findByExternalId(
              provider.type,
              connection.externalId,
            );
            integrationId = existing?.id ?? null;
            if (existing === undefined)
              await createFromConnection(provider, connection, summary);
            else
              await applyConnection(
                provider,
                existing,
                connection,
                summary,
                false,
              );
          } catch (error) {
            recordFailure(summary, "connection", integrationId, error);
          }
        },
      );
    }

    // A row the list does not mention is not necessarily gone: it may have been created by a
    // delivery after the list was read. Only the platform's own answer about that one connection,
    // asked inside the lock, decides; without that answer the row is left alone.
    for (const known of await directory.list()) {
      if (known.type !== provider.type || seen.has(known.externalId)) continue;
      await lock.run(lockKey(known.type, known.externalId), async () => {
        try {
          const current = await directory.get(known.id);
          if (current === undefined || provider.findConnection === undefined)
            return;
          const confirmed = await provider.findConnection(current.externalId);
          if (confirmed === null) await disableAndDeactivate(current, summary);
          else
            await applyConnection(provider, current, confirmed, summary, true);
        } catch (error) {
          recordFailure(summary, "connection", known.id, error);
        }
      });
    }

    for (const integration of await directory.list()) {
      if (integration.type !== provider.type || integration.status !== "active")
        continue;
      await lock.run(
        lockKey(integration.type, integration.externalId),
        async () => {
          try {
            await syncRepositories(provider, integration.id, summary);
          } catch (error) {
            recordFailure(summary, "repositories", integration.id, error);
          }
        },
      );
    }
  }

  return {
    async syncAll() {
      const summary = emptySummary();
      for (const type of registry.registeredTypes()) {
        try {
          await discoverAndSync(registry.resolve(type), summary);
        } catch (error) {
          recordFailure(summary, "discover", null, error);
        }
      }
      return summary;
    },

    async syncIntegration(integrationId) {
      const summary = emptySummary();
      const integration = await directory.get(integrationId);
      if (integration === undefined) return summary;
      await lock.run(lockKey(integration.type, integration.externalId), () =>
        syncRepositories(
          registry.resolve(integration.type),
          integrationId,
          summary,
        ),
      );
      return summary;
    },

    async handleInstallationChange({ type, externalId, action }) {
      const summary = emptySummary();
      const provider = registry.resolve(type);

      const outcome = await lock.run(
        lockKey(type, externalId),
        async (): Promise<InstallationChangeOutcome> => {
          try {
            let integration = await directory.findByExternalId(
              type,
              externalId,
            );

            if (action === "deleted") {
              if (integration === undefined) return "unknown_installation";
              await disableAndDeactivate(integration, summary);
              return "deactivated";
            }

            if (integration === undefined) {
              if (provider.findConnection === undefined)
                return "unknown_installation";
              // The delivery is signed, but a row is only created for an installation that GitHub
              // itself confirms to the app.
              const connection = await provider.findConnection(externalId);
              if (connection === null) return "installation_not_found";
              integration = await createFromConnection(
                provider,
                connection,
                summary,
              );
              if (integration === undefined) return "failed";
              const created = summary.integrations.created > 0;
              if (integration.status !== "active") return "disabled";
              await syncRepositories(provider, integration.id, summary);
              return summary.errors.length > 0
                ? "failed"
                : created
                  ? "created"
                  : "synced";
            }

            // These deliveries can be retried or arrive out of order, so what they say is checked
            // against GitHub's current answer before the row is changed.
            if (
              (action === "created" ||
                action === "suspended" ||
                action === "unsuspended") &&
              provider.findConnection !== undefined
            ) {
              const connection = await provider.findConnection(externalId);
              if (connection === null) return "installation_not_found";
              integration = await applyConnection(
                provider,
                integration,
                connection,
                summary,
                true,
              );
            }
            if (integration.status !== "active")
              return action === "suspended" ? "disabled" : "skipped_disabled";

            await syncRepositories(provider, integration.id, summary);
            return summary.errors.length > 0 ? "failed" : "synced";
          } catch (error) {
            recordFailure(summary, "connection", null, error);
            return "failed";
          }
        },
      );
      return { outcome, summary };
    },
  };
}
