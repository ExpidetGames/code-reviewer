// SPDX-License-Identifier: LicenseRef-Proprietary

// The "test key" service as the running server wires it, over a database (src/llm/shared.ts passes the server's): counted in the
// shared `rate_limits` table, connecting to the provider's own address only (src/llm/endpoint.ts), a catalog provider tested at the
// trusted address of its row, through the connect guard, and held to the addresses the workspace's projects pinned (#588, all of them: #614). Kept
// apart from the server-only module so a test can run exactly this wiring over its own database.
import type { Kysely } from "kysely";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";
import type { AddressResolver } from "../models-dev/connect-guard.ts";
import type { FetchLike } from "../models-dev/fetch.ts";
import { createNativeKeyTester } from "../native-providers/key-test.ts";
import { createPinnedAddressReader } from "../review-settings/pinned-addresses.ts";
import { llmApiBaseUrl } from "./endpoint.ts";
import { createLlmKeyTestService, type LlmKeyTestService } from "./key-test.ts";
import { llmProviderDescriptors } from "./providers/index.ts";

export function createWiredLlmKeyTester({
  db,
  env,
  fetchImpl,
  resolveAddresses,
}: {
  db: Kysely<Database>;
  /** The process environment as it is right now (the test stack's switch of the provider address). */
  env: () => Readonly<Record<string, string | undefined>>;
  /** Only a test passes these two: the transport of a catalog provider's test. */
  fetchImpl?: FetchLike;
  resolveAddresses?: AddressResolver;
}): LlmKeyTestService {
  return createLlmKeyTestService({
    rateLimits: createRateLimitsRepository(db),
    baseUrlOf: (provider) => llmApiBaseUrl(env(), provider).url,
    // A catalog provider (#555) is tested at the trusted address of its row, through the connect guard.
    native: createNativeKeyTester({
      models: createModelsDevRepository(db),
      legacyProviders: llmProviderDescriptors.ids,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(resolveAddresses === undefined ? {} : { resolveAddresses }),
    }),
    // #588: the test is held to the address the projects of the workspace pinned for the provider, as a claim is. Every project
    // counts, also one on Diff Review or switched off (#614): a Member may switch a project over, and its pin must not leave the
    // test with it.
    pinnedAddresses: (workspaceId, slug) =>
      createPinnedAddressReader(createProjectsRepository(db, workspaceId))(
        slug,
      ),
  });
}
