// SPDX-License-Identifier: LicenseRef-Proprietary

// Shared setup of the review settings integration tests: a real Postgres database with one repository, and
// the service on top of it. Not product code.
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import {
  createProjectsRepository,
  type NewProjectSettings,
} from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./test-database.ts";
import { defaultWorkspaceId } from "./workspaces.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { readDefaultReviewSkill } from "../review-settings/default-skill.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import type { ReviewSettingsHooks } from "../review-settings/hooks.ts";
import {
  catalogSelectionFrom,
  type CatalogSelectionSource,
} from "../review-settings/catalog-selection.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import type { ProviderLookup } from "../review-settings/validate.ts";
import type { NativeSelectionSource } from "../native-providers/catalog.ts";

export const TEST_MODEL = "deepseek/deepseek-v3.2";

/** The shipped default skill, so a test can compare against the exact text a project resolves to. */
export const TEST_DEFAULT_SKILL = readDefaultReviewSkill();

export async function seedRepositories(
  db: Kysely<Database>,
  workspaceId?: string,
  /** The external id of the integration; a second workspace needs another one (an installation belongs to one workspace). */
  integrationExternalId = "4242",
) {
  const workspace = workspaceId ?? (await defaultWorkspaceId(db));
  const integration = await createIntegrationsRepository(db, workspace).create({
    type: "github_app",
    displayName: "acme",
    externalId: integrationExternalId,
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspace);
  await repositories.reconcile(
    integration.id,
    ["widgets", "gadgets"].map((name, index) => ({
      integrationId: integration.id,
      externalId: String(index + 1),
      fullName: `acme/${name}`,
      url: `https://github.test/acme/${name}`,
    })),
  );
  const [first, second] = await repositories.list();
  if (first === undefined || second === undefined)
    throw new Error("seeding failed");
  return { first, second, workspaceId: workspace };
}

export async function setupReviewSettings(
  db?: Kysely<Database>,
  options: {
    hooks?: ReviewSettingsHooks;
    modelCapabilities?: ModelCapabilityChecker;
    /** #280: whether the workspace's models are the operator's (its key mode is `managed`); default false. */
    operatorsModels?: boolean;
    /** #430: the catalog a managed workspace selects from; default an empty one. */
    catalog?: CatalogSelectionSource;
    /** #430: a registry with a second provider; default the registry of the app. */
    providers?: ProviderLookup;
    /** #555: the catalog a Dynamic provider outside the registry is checked against; default none. */
    nativeCatalog?: NativeSelectionSource;
    /** #656: what a project that is created starts with; default nothing. */
    newProjectSettings?: NewProjectSettings;
    /** #676: whether Dynamic Review can run with the workspace defaults; default: not asked. */
    dynamicReady?: Parameters<
      typeof createReviewSettingsService
    >[0]["dynamicReady"];
    /** The clock of the workspace defaults, so two saves can be told apart; default the real one. */
    settingsClock?: () => Date;
    /** #731: which review kinds the deployment has a capability for; default all. */
    kindAllowed?: Parameters<
      typeof createReviewSettingsService
    >[0]["kindAllowed"];
  } = {},
) {
  const database = db ?? (await createTestDatabase()).db;
  const workspaceId = await defaultWorkspaceId(database);
  const { first, second } = await seedRepositories(database, workspaceId);
  const projects = createProjectsRepository(
    database,
    workspaceId,
    undefined,
    undefined,
    undefined,
    options.newProjectSettings,
  );
  const appSettings = createAppSettingsRepository(
    database,
    workspaceId,
    options.settingsClock,
  );
  let model = TEST_MODEL;
  let operatorsModels = options.operatorsModels === true;
  const service = createReviewSettingsService({
    appSettings,
    projects,
    builtIn: () => builtInReviewSettings(model),
    defaultSkill: () => TEST_DEFAULT_SKILL,
    operatorsModels: async () => operatorsModels,
    // #689: as on the running server, the operator's maximum per review is the instance setting.
    operatorCostLimitCents: operatorCostLimitCentsFrom(database),
    ...(options.newProjectSettings === undefined
      ? {}
      : {
          newProjectSettings: () =>
            options.newProjectSettings?.(database, workspaceId) ??
            Promise.resolve({}),
        }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.kindAllowed === undefined
      ? {}
      : { kindAllowed: options.kindAllowed }),
    ...(options.dynamicReady === undefined
      ? {}
      : { dynamicReady: options.dynamicReady }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.providers === undefined
      ? {}
      : { providers: options.providers }),
    ...(options.modelCapabilities === undefined
      ? {}
      : { modelCapabilities: options.modelCapabilities }),
    ...(options.nativeCatalog === undefined
      ? {}
      : { nativeCatalog: options.nativeCatalog }),
  });
  return {
    db: database,
    workspaceId,
    first,
    second,
    projects,
    appSettings,
    service,
    setInstanceModel(next: string) {
      model = next;
    },
    /** #689: the admin sets the maximum cost per review (whole US cents). */
    setOperatorCostLimit: (cents: number) =>
      createInstanceSettingsRepository(database).set(
        "review_max_cost_cents",
        cents,
        null,
      ),
    /** #283: the workspace's key mode changes (own key to managed and back). */
    setOperatorsModels(next: boolean) {
      operatorsModels = next;
    },
    appSettingRows: () =>
      database.selectFrom("app_settings").selectAll().execute(),
    projectRows: () => database.selectFrom("projects").selectAll().execute(),
  };
}

/**
 * #430: a real catalog on the test database for the selection of a managed workspace. Entries are made through the
 * catalog service (every model is vouched for by the metadata check), and a test says which ones the plan allows.
 * `reads` counts the questions the review settings put to the catalog, so a test can pin that an own-key workspace
 * asks none; `finds` counts the lookups of one entry by id (the check of a choice).
 */
export function createCatalogFixture(db: Kysely<Database>) {
  const service = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities: {
      check: async () => ({
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
  const notAllowed = new Set<string>();
  const reads = { count: 0, finds: 0 };
  const inner = catalogSelectionFrom(
    service,
    async (id) => !notAllowed.has(id),
  );
  const source: CatalogSelectionSource = {
    entries: async () => {
      reads.count += 1;
      return inner.entries();
    },
    find: async (id) => {
      reads.count += 1;
      reads.finds += 1;
      return inner.find(id);
    },
    allowed: async (id) => {
      reads.count += 1;
      return inner.allowed(id);
    },
  };
  let counter = 0;

  return {
    service,
    source,
    reads,
    /** The plan no longer allows this entry (`modelAccess`). */
    forbid(id: string) {
      notAllowed.add(id);
    },
    /** A new entry in the given status; the model id is a sentinel a test can search for. */
    async entry(
      options: {
        name?: string;
        kinds?: ProjectReviewKind[];
        status?: "draft" | "released" | "retired";
        modelId?: string;
      } = {},
    ) {
      counter += 1;
      const created = await service.create(
        {
          name: options.name ?? `Choice ${String(counter)}`,
          description: `A choice number ${String(counter)}.`,
          provider: "openrouter",
          modelId: options.modelId ?? `sentinel/entry-model-${String(counter)}`,
          kinds: options.kinds ?? ["diff", "dynamic"],
        },
        null,
      );
      if (!created.ok) throw new Error(`create refused: ${created.code}`);
      const status = options.status ?? "released";
      if (status === "draft") return created.entry;
      const released = await service.release(created.entry.id, null);
      if (!released.ok) throw new Error(`release refused: ${released.code}`);
      if (status === "released") return released.entry;
      const retired = await service.retire(created.entry.id, null);
      if (!retired.ok) throw new Error(`retire refused: ${retired.code}`);
      return retired.entry;
    },
  };
}
