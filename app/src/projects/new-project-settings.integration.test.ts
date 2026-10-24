// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import { DYNAMIC_REVIEW_SETTING_KEY } from "../jobs/dynamic-review-gate.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { createWorkspaceLlmKeyService } from "../llm/workspace-key.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { newProjectSettings } from "./new-project-settings.ts";

const APP_SECRET = "new-project-test-app-secret-0123456789-0123";
const KEYS: Record<string, string> = {
  openrouter: "sk-or-v1-dummy-0123456789abcdef0123456789abcdef",
  // Written in two parts so that the scan for committed keys does not read a dummy as a key.
  anthropic: "sk-ant-" + "dummy-012345678901234567890123456789",
};
const DEFAULT_PROVIDER = llmProviderDescriptors.defaultProvider.id;
const OTHER_PROVIDER = llmProviderDescriptors.ids.find(
  (id) => id !== DEFAULT_PROVIDER,
)!;

async function start({ dynamicOn = true }: { dynamicOn?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  if (dynamicOn)
    await createInstanceSettingsRepository(db).set(
      DYNAMIC_REVIEW_SETTING_KEY,
      { enabled: true },
      null,
    );
  return { db, workspaceId };
}

async function storeKey(
  db: Kysely<Database>,
  workspaceId: string,
  provider: string,
) {
  const store = createWorkspaceSecretStore({
    db,
    workspaceId,
    appSecret: APP_SECRET,
  });
  const saved = await createWorkspaceLlmKeyService({ store }).save(
    { provider, apiKey: KEYS[provider]! },
    null,
  );
  expect(saved.ok).toBe(true);
}

async function chooseManaged(db: Kysely<Database>, workspaceId: string) {
  await createWorkspaceEntitlementsRepository(db, workspaceId).put(
    {
      planLabel: "team",
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: null,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    },
    null,
  );
}

/** A released entry that serves the kinds, named as the instance default of Dynamic Review unless told otherwise. */
async function addEntry(
  db: Kysely<Database>,
  {
    kinds = ["dynamic"],
    release = true,
    makeDefault = true,
  }: {
    kinds?: Array<"diff" | "dynamic">;
    release?: boolean;
    makeDefault?: boolean;
  } = {},
) {
  const repository = createCatalogRepository(db);
  const entry = await repository.insert(
    {
      name: "Thorough",
      nameKey: "thorough",
      description: null,
      provider: "openrouter",
      modelId: "acme/thorough-1",
      kinds,
      sortOrder: 0,
    },
    null,
  );
  if (release) await repository.setStatus(entry.id, "draft", "released", null);
  if (makeDefault)
    await createInstanceSettingsRepository(db).set(
      "catalog_defaults",
      { diff: null, dynamic: entry.id },
      null,
    );
  return entry;
}

// #656-T02
describe("the settings a new project starts with", () => {
  it("name no kind while Dynamic Review is off, so the project keeps working as a Diff Review", async () => {
    const { db, workspaceId } = await start({ dynamicOn: false });
    await storeKey(db, workspaceId, DEFAULT_PROVIDER);

    expect(await newProjectSettings(db, workspaceId)).toEqual({});
  });

  describe("on the workspace's own key", () => {
    it("name Dynamic Review when a key is stored for the provider a Dynamic Review starts on", async () => {
      const { db, workspaceId } = await start();
      await storeKey(db, workspaceId, DEFAULT_PROVIDER);

      expect(await newProjectSettings(db, workspaceId)).toEqual({
        reviewKind: "dynamic",
      });
    });

    it("name no kind while no key is stored, because the first review would be refused", async () => {
      const { db, workspaceId } = await start();

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("name no kind when the only key is one of another provider", async () => {
      const { db, workspaceId } = await start();
      await storeKey(db, workspaceId, OTHER_PROVIDER);

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("read the key of this workspace only", async () => {
      const { db, workspaceId } = await start();
      const other = await addWorkspace(db, "other");
      await storeKey(db, other, DEFAULT_PROVIDER);

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });
  });

  describe("on the operator's key", () => {
    it("name Dynamic Review when the instance default of Dynamic Review is a usable catalog entry", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await addEntry(db);

      expect(await newProjectSettings(db, workspaceId)).toEqual({
        reviewKind: "dynamic",
      });
    });

    it("name no kind without a Dynamic default entry, the state of today's production", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await addEntry(db, { makeDefault: false });

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("name no kind when the default entry is not released", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await addEntry(db, { release: false });

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("name no kind when the default entry does not serve Dynamic Review", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await addEntry(db, { kinds: ["diff"] });

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("name no kind when the plan does not allow the default entry", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await addEntry(db);
      await createWorkspaceEntitlementsRepository(db, workspaceId).put(
        {
          planLabel: "team",
          keyMode: "managed",
          limits: {
            diffRunsPerPeriod: null,
            dynamicRunsPerPeriod: null,
            managedCostLimitMicroUsd: null,
            ownKeyCostLimitMicroUsd: null,
          },
          periodStart: "2026-10-01T00:00:00.000Z",
          suspended: false,
          suspensionCode: null,
          modelAccess: { catalogEntries: [] },
        },
        null,
      );

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });

    it("name no kind when a key is stored but the workspace is on the operator's key and has no default entry", async () => {
      const { db, workspaceId } = await start();
      await chooseManaged(db, workspaceId);
      await storeKey(db, workspaceId, DEFAULT_PROVIDER);

      expect(await newProjectSettings(db, workspaceId)).toEqual({});
    });
  });
});
