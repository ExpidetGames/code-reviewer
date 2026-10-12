// SPDX-License-Identifier: Apache-2.0

// Puts the binding together over one database and one set of collaborators. The running server (`shared.ts`)
// and the integration tests (`src/test-support/binding-harness.ts`) both build it here, so a test runs the code
// that serves requests.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  createUnclaimedInstallationsRepository,
  type UnclaimedInstallationsRepository,
} from "../db/repositories/unclaimed-installations-repository.ts";
import type { Database } from "../db/schema.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import type { KeyedLock } from "../integrations/sync/keyed-lock.ts";
import {
  createSignedStates,
  type SignedStates,
} from "../signed-state/state.ts";
import { createApprovalService, type ApprovalService } from "./approvals.ts";
import { createConnections, type Connections } from "./connections.ts";
import {
  createInstallationBindingService,
  type GithubFacts,
  type InstallationBindingService,
} from "./service.ts";

/**
 * The tenancy of the instance as the binding reads it. FAIL CLOSED: an instance whose tenancy is not stored
 * (not set up, or the row is gone) is multi-tenant, which never binds an installation without a person's proof
 * and never attaches one on its own.
 */
export async function bindingTenancy(
  db: Kysely<Database>,
): Promise<"single" | "multi"> {
  return (await createInstanceSettingsRepository(db).get("tenancy")) ?? "multi";
}

export type AssembleBindingOptions = {
  db: Kysely<Database>;
  registry: IntegrationRegistry;
  sync: Pick<IntegrationSyncService, "syncIntegration">;
  /** The master key (`APP_SECRET`): the key of the signed states is derived from it. */
  appSecret: string;
  publicUrl: string;
  oauthBaseUrl: string;
  apiBaseUrl: string;
  github: () => Promise<GithubFacts>;
  tenancy: () => Promise<"single" | "multi">;
  lock?: KeyedLock;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export type AssembledBinding = {
  service: InstallationBindingService;
  connections: Connections;
  approvals: ApprovalService;
  /** The installations of the App that no workspace has linked (what the admin portal lists). */
  unclaimed: UnclaimedInstallationsRepository;
  signedStates: SignedStates;
};

export function assembleInstallationBinding(
  options: AssembleBindingOptions,
): AssembledBinding {
  const { db, now, log } = options;
  const signedStates = createSignedStates({
    db,
    appSecret: options.appSecret,
    ...(now === undefined ? {} : { now }),
  });
  const connections = createConnections({
    db,
    registry: options.registry,
    sync: options.sync,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
    ...(now === undefined ? {} : { now }),
    ...(log === undefined ? {} : { log }),
  });
  const service = createInstallationBindingService({
    db,
    signedStates,
    rateLimits: createRateLimitsRepository(db, now),
    registry: options.registry,
    connections,
    github: options.github,
    tenancy: options.tenancy,
    publicUrl: options.publicUrl,
    oauthBaseUrl: options.oauthBaseUrl,
    apiBaseUrl: options.apiBaseUrl,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(now === undefined ? {} : { now }),
    ...(log === undefined ? {} : { log }),
  });
  return {
    service,
    connections,
    approvals: createApprovalService({
      db,
      connections,
      ...(now === undefined ? {} : { now }),
    }),
    unclaimed: createUnclaimedInstallationsRepository(db, now),
    signedStates,
  };
}
