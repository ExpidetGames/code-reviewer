// Shared setup of the review settings integration tests: a real SQLite file with one repository, and
// the service on top of it. Not product code.
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./test-database.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";

export const TEST_MODEL = "deepseek/deepseek-v3.2";

export async function seedRepositories(db: Kysely<Database>) {
  const integration = await createIntegrationsRepository(db).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db);
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
  return { first, second };
}

export async function setupReviewSettings(db?: Kysely<Database>) {
  const database = db ?? (await createTestDatabase()).db;
  const { first, second } = await seedRepositories(database);
  const projects = createProjectsRepository(database);
  const appSettings = createAppSettingsRepository(database);
  let model = TEST_MODEL;
  const service = createReviewSettingsService({
    appSettings,
    projects,
    builtIn: () => builtInReviewSettings(model),
  });
  return {
    db: database,
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
