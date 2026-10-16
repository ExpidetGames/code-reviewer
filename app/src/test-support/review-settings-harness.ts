// SPDX-License-Identifier: Apache-2.0

// Shared setup of the review settings integration tests: a real SQLite file with one repository, and
// the service on top of it. Not product code.
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./test-database.ts";
import { defaultWorkspaceId } from "./workspaces.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { readDefaultReviewSkill } from "../review-settings/default-skill.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import type { ReviewSettingsHooks } from "../review-settings/hooks.ts";

export const TEST_MODEL = "deepseek/deepseek-v3.2";

/** The shipped default skill, so a test can compare against the exact text a project resolves to. */
export const TEST_DEFAULT_SKILL = readDefaultReviewSkill();

export async function seedRepositories(
  db: Kysely<Database>,
  workspaceId?: string,
) {
  const workspace = workspaceId ?? (await defaultWorkspaceId(db));
  const integration = await createIntegrationsRepository(db, workspace).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
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
  } = {},
) {
  const database = db ?? (await createTestDatabase()).db;
  const workspaceId = await defaultWorkspaceId(database);
  const { first, second } = await seedRepositories(database, workspaceId);
  const projects = createProjectsRepository(database, workspaceId);
  const appSettings = createAppSettingsRepository(database, workspaceId);
  let model = TEST_MODEL;
  const service = createReviewSettingsService({
    appSettings,
    projects,
    builtIn: () => builtInReviewSettings(model),
    defaultSkill: () => TEST_DEFAULT_SKILL,
    ...(options.operatorsModels === true
      ? { operatorsModels: async () => true }
      : {}),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.modelCapabilities === undefined
      ? {}
      : { modelCapabilities: options.modelCapabilities }),
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
    appSettingRows: () =>
      database.selectFrom("app_settings").selectAll().execute(),
    projectRows: () => database.selectFrom("projects").selectAll().execute(),
  };
}
