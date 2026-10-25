// SPDX-License-Identifier: LicenseRef-Proprietary

// The context window of a model as the app already knows it from public metadata (#689): the models.dev catalog the app keeps in its
// database. It asks nobody: a Diff job on the workspace's own key must not make the app call the customer's provider with the
// customer's key, and this is how such a job is still cut to the window of its model.
import type { Kysely } from "kysely";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { Database } from "../db/schema.ts";

/** The window in tokens the catalog states for the model of that provider, or null (not listed, or no usable window). */
export type KnownContextWindow = (
  provider: string,
  modelId: string,
) => Promise<number | null>;

export function knownContextWindowFrom(
  db: Kysely<Database>,
): KnownContextWindow {
  const models = createModelsDevRepository(db);
  return async (provider, modelId) => {
    // A model the catalog no longer lists keeps its last row, which is still the best statement of its window.
    const context = (await models.getModel(provider, modelId))?.limit.context;
    return context !== undefined && context > 0 ? context : null;
  };
}
