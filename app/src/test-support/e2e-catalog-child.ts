// SPDX-License-Identifier: Apache-2.0

// A program the Playwright journeys run (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to fill the model catalog of the app under test the way the
// admin portal will: through the real catalog service on the app's SQLite file, never by writing rows. The provider's
// metadata check is answered "supported" here (the journey has no provider to ask), everything else is the service's
// own rules. The app is a separate process with the same file open (WAL), so the entries show up in its pages.
//
//   seed <db> <json>       [{name, description?, modelId, kinds, sortOrder?}, ...]   -> {names: {<name>: <entry id>}}
//   defaults <db> <json>   {diff: <entry id> | null, dynamic: <entry id> | null}          -> {defaults: {diff, dynamic}}
//
// Every entry is created for the default provider and released. Prints one JSON line.
import { openDatabase } from "../db/connection.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import { createCatalogService } from "../model-catalog/service.ts";

const [command, databasePath, argument] = process.argv.slice(2);
if (
  (command !== "seed" && command !== "defaults") ||
  !databasePath ||
  !argument
)
  throw new Error("Usage: e2e-catalog-child.ts seed|defaults <db> <json>");

type Seed = {
  name: string;
  description?: string;
  modelId: string;
  kinds: string[];
  sortOrder?: number;
};

const db = openDatabase({
  driver: "sqlite",
  path: databasePath,
  busyTimeoutMs: 5000,
});
try {
  const service = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities: {
      check: () =>
        Promise.resolve({
          outcome: "supported" as const,
          capabilities: {
            tools: true,
            toolChoice: true,
            toolChoiceRequired: true,
            responseFormat: true,
            structuredOutputs: true,
            maxCompletionTokens: 8192,
            smallestCompletionTokens: 8192,
            contextLength: 200_000,
            inputUsdPerMtok: null,
            outputUsdPerMtok: null,
          },
        }),
    },
    logger: { info: () => undefined },
  });
  if (command === "defaults") {
    const chosen = JSON.parse(argument) as {
      diff: string | null;
      dynamic: string | null;
    };
    const saved = await service.setDefaults(chosen, null);
    if (!saved.ok) throw new Error(`Defaults: ${saved.code}`);
    console.log(JSON.stringify({ defaults: saved.defaults }));
  } else {
    const entries = JSON.parse(argument) as Seed[];
    const names: Record<string, string> = {};
    for (const seed of entries) {
      const created = await service.create(
        { ...seed, provider: DEFAULT_LLM_PROVIDER },
        null,
      );
      if (!created.ok) throw new Error(`Entry ${seed.name}: ${created.code}`);
      const released = await service.release(created.entry.id, null);
      if (!released.ok) throw new Error(`Entry ${seed.name}: ${released.code}`);
      names[seed.name] = created.entry.id;
    }
    console.log(JSON.stringify({ names }));
  }
} finally {
  await db.destroy();
}
