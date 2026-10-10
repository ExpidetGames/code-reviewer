// Pins down the integrations repository against a real SQLite file: what goes in comes out
// unchanged, a GitHub App row never holds a secret, and bad input is refused with a stable code.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../integrations/types.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";

const gitHubApp = {
  type: "github_app" as const,
  displayName: "Acme on GitHub",
  externalId: "12345678",
  config: { accountLogin: "acme", accountId: 5, nested: { a: [1, 2] } },
};

describe("the integrations repository", () => {
  // CR-20-T02
  it("reads back the type and configuration exactly as they were saved", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);

    const saved = await repository.create(gitHubApp);
    const loaded = await repository.get(saved.id);

    expect(loaded).toEqual(saved);
    expect(loaded).toMatchObject({
      type: "github_app",
      displayName: "Acme on GitHub",
      externalId: "12345678",
      config: gitHubApp.config,
      status: "active",
    });
  });

  it("stores the configuration as JSON text and the timestamps as ISO 8601", async () => {
    const { db } = await createTestDatabase();
    const now = new Date("2026-10-10T08:00:00.123Z");
    const repository = createIntegrationsRepository(db, () => now);

    const saved = await repository.create(gitHubApp);

    const { rows } = await sql<{
      config: string;
      config_type: string;
      created_at: string;
      updated_at: string;
    }>`select config, typeof(config) as config_type, created_at, updated_at
       from integrations where id = ${saved.id}`.execute(db);
    expect(rows).toEqual([
      {
        config: JSON.stringify(gitHubApp.config),
        config_type: "text",
        created_at: "2026-10-10T08:00:00.123Z",
        updated_at: "2026-10-10T08:00:00.123Z",
      },
    ]);
  });

  it("returns undefined for an id that does not exist", async () => {
    const { db } = await createTestDatabase();

    expect(
      await createIntegrationsRepository(db).get("missing"),
    ).toBeUndefined();
  });

  it("finds an integration by its type and the platform's id and lists all of them", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);
    const first = await repository.create(gitHubApp);
    const second = await repository.create({
      ...gitHubApp,
      displayName: "Other",
      externalId: "999",
    });

    expect(await repository.findByExternalId("github_app", "999")).toEqual(
      second,
    );
    expect(
      await repository.findByExternalId("github_app", "nope"),
    ).toBeUndefined();
    expect(new Set((await repository.list()).map((i) => i.id))).toEqual(
      new Set([first.id, second.id]),
    );
  });

  it("changes the status and moves the update time", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-10T08:00:00.000Z");
    const repository = createIntegrationsRepository(db, () => now);
    const saved = await repository.create(gitHubApp);

    now = new Date("2026-10-10T09:00:00.000Z");
    await repository.setStatus(saved.id, "disabled");

    expect(await repository.get(saved.id)).toMatchObject({
      status: "disabled",
      createdAt: "2026-10-10T08:00:00.000Z",
      updatedAt: "2026-10-10T09:00:00.000Z",
    });
  });

  it("refuses a second integration with the same type and platform id", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);
    await repository.create(gitHubApp);

    await expect(repository.create(gitHubApp)).rejects.toMatchObject({
      code: "INTEGRATION_ALREADY_EXISTS",
    });
    expect(await repository.list()).toHaveLength(1);
  });

  it("refuses to change the status of an integration that does not exist", async () => {
    const { db } = await createTestDatabase();

    await expect(
      createIntegrationsRepository(db).setStatus("missing", "disabled"),
    ).rejects.toMatchObject({ code: "INTEGRATION_NOT_FOUND" });
  });

  it("refuses an integration without the platform's id and stores nothing", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);

    for (const externalId of [undefined, "", null]) {
      await expect(
        repository.create({ ...gitHubApp, externalId: externalId as never }),
      ).rejects.toMatchObject({ code: "INTEGRATION_EXTERNAL_ID_REQUIRED" });
    }

    expect(await repository.list()).toEqual([]);
  });

  it("refuses a status it does not know, on create and on update", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);
    const saved = await repository.create(gitHubApp);

    await expect(
      repository.create({
        ...gitHubApp,
        externalId: "2",
        status: "paused" as never,
      }),
    ).rejects.toMatchObject({ code: "INTEGRATION_STATUS_INVALID" });
    await expect(
      repository.setStatus(saved.id, "paused" as never),
    ).rejects.toMatchObject({ code: "INTEGRATION_STATUS_INVALID" });

    expect(await repository.get(saved.id)).toMatchObject({ status: "active" });
  });

  it("fails with a stable code when a stored row has a status this version does not know", async () => {
    const { db } = await createTestDatabase();
    await sql`insert into integrations
      (id, type, display_name, external_id, config, status, created_at, updated_at)
      values ('x', 'github_app', 'Old', '1', '{}', 'paused', 'now', 'now')`.execute(
      db,
    );

    await expect(
      createIntegrationsRepository(db).get("x"),
    ).rejects.toMatchObject({ code: "INTEGRATION_STATUS_INVALID" });
  });

  it("refuses a type it does not know with a stable code", async () => {
    const { db } = await createTestDatabase();

    await expect(
      createIntegrationsRepository(db).create({
        ...gitHubApp,
        type: "gitlab" as never,
      }),
    ).rejects.toMatchObject({ code: "INTEGRATION_TYPE_UNKNOWN" });
  });

  it("fails with a stable code when a stored row has a type this version does not know", async () => {
    const { db } = await createTestDatabase();
    await sql`insert into integrations
      (id, type, display_name, external_id, config, status, created_at, updated_at)
      values ('x', 'gitlab', 'Old', '1', '{}', 'active', 'now', 'now')`.execute(
      db,
    );

    await expect(
      createIntegrationsRepository(db).get("x"),
    ).rejects.toMatchObject({ code: "INTEGRATION_TYPE_UNKNOWN" });
  });
});

describe("secrets in the integrations table", () => {
  // CR-20-T05
  it("keeps no private key, webhook secret or token in the row of a GitHub App", async () => {
    const { db } = await createTestDatabase();
    const saved = await createIntegrationsRepository(db).create(gitHubApp);

    const { rows } = await sql<Record<string, unknown>>`
      select * from integrations where id = ${saved.id}`.execute(db);

    const row = rows[0]!;
    expect(row.credentials).toBeNull();
    expect(row.webhook_secret).toBeNull();
    expect(JSON.stringify(Object.values(row))).not.toMatch(
      /private|secret|token|password|BEGIN/i,
    );
  });

  // CR-20-T05
  it("refuses a webhook secret or credentials for a GitHub App and stores nothing", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);

    await expect(
      repository.create({ ...gitHubApp, webhookSecret: "whsec_dummy" }),
    ).rejects.toMatchObject({ code: "INTEGRATION_SECRET_NOT_ALLOWED" });
    await expect(
      repository.create({ ...gitHubApp, credentials: { token: "ghs_dummy" } }),
    ).rejects.toMatchObject({ code: "INTEGRATION_SECRET_NOT_ALLOWED" });

    expect(await repository.list()).toEqual([]);
  });

  // CR-20-T05
  it("refuses a configuration that carries a key, secret or token and stores nothing", async () => {
    const { db } = await createTestDatabase();
    const repository = createIntegrationsRepository(db);

    const configs: Array<{ [key: string]: JsonValue }> = [
      { privateKey: "-----BEGIN RSA PRIVATE KEY-----" },
      { auth: { accessToken: "ghs_dummy" } },
      { webhook_secret: "whsec_dummy" },
    ];
    for (const config of configs) {
      await expect(
        repository.create({ ...gitHubApp, config }),
      ).rejects.toMatchObject({ code: "INTEGRATION_SECRET_NOT_ALLOWED" });
    }

    expect(await repository.list()).toEqual([]);
  });

  it("does not echo the offending value in the error", async () => {
    const { db } = await createTestDatabase();

    const failure = await createIntegrationsRepository(db)
      .create({ ...gitHubApp, config: { privateKey: "SUPER-SECRET-VALUE" } })
      .catch((error: unknown) => error);

    expect(String((failure as Error).message)).not.toContain(
      "SUPER-SECRET-VALUE",
    );
    expect(String((failure as Error).message)).toContain("privateKey");
  });
});
