// SPDX-License-Identifier: Apache-2.0

// Which adapter billing runs on (ADR 0006, 2.14; #497). The instance setting `billing_settings` names it in `adapter`; the
// admin page that sets it comes with #504, until then every instance runs on `manual`, the adapter that needs nothing.
// A stored value that is not an adapter id reads as `manual`, never as an error: this is read on a public route.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  isAdapterId,
  type AdapterRegistry,
  type BillingAdapter,
} from "./adapter.ts";

export const DEFAULT_ADAPTER_ID = "manual";

export function readActiveAdapterId(stored: unknown): string {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return DEFAULT_ADAPTER_ID;
  const { adapter } = stored as { adapter?: unknown };
  return isAdapterId(adapter) ? adapter : DEFAULT_ADAPTER_ID;
}

/** The adapter in use, or undefined when the setting names one this instance does not have. */
export function createActiveAdapterResolver(
  db: Kysely<Database>,
  registry: AdapterRegistry,
): () => Promise<BillingAdapter | undefined> {
  return async () =>
    registry.get(
      readActiveAdapterId(
        await createInstanceSettingsRepository(db).get("billing_settings"),
      ),
    );
}
