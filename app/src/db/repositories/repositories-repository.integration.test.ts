// Pins down the repositories table against a real SQLite file: reconciling a list from the platform
// adds, renames, deactivates and reactivates rows without ever deleting or duplicating one.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { RepoRef } from "../../integrations/types.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import type { Database } from "../schema.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  const integrations = createIntegrationsRepository(db, now);
  const first = await integrations.create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const second = await integrations.create({
    type: "github_app",
    displayName: "octocat",
    externalId: "4300",
    config: {},
  });
  return {
    db,
    first,
    second,
    repositories: createRepositoriesRepository(db, now),
  };
}

const repo = (
  integrationId: string,
  id: number,
  fullName = `acme/repo-${id}`,
): RepoRef => ({
  integrationId,
  externalId: String(id),
  fullName,
  url: `https://github.test/${fullName}`,
});

describe("reconciling the repositories of an integration", () => {
  it("adds every repository as an active row", async () => {
    const { first, repositories } = await setup();

    const result = await repositories.reconcile(first.id, [
      repo(first.id, 1),
      repo(first.id, 2),
    ]);

    expect(result).toEqual({
      added: 2,
      reactivated: 0,
      updated: 0,
      deactivated: 0,
      unchanged: 0,
    });
    expect(await repositories.list({ integrationId: first.id })).toMatchObject([
      { externalId: "1", fullName: "acme/repo-1", active: true },
      { externalId: "2", fullName: "acme/repo-2", active: true },
    ]);
  });

  // CR-21-T07
  it("changes nothing when the same list is reconciled again", async () => {
    const { first, repositories } = await setup();
    const list = [repo(first.id, 1), repo(first.id, 2)];
    await repositories.reconcile(first.id, list);
    const before = await repositories.list();

    const result = await repositories.reconcile(first.id, list);

    expect(result).toEqual({
      added: 0,
      reactivated: 0,
      updated: 0,
      deactivated: 0,
      unchanged: 2,
    });
    expect(await repositories.list()).toEqual(before);
  });

  // CR-21-T04
  it("marks a repository that is no longer listed as inactive and keeps its row", async () => {
    const { first, repositories } = await setup();
    await repositories.reconcile(first.id, [
      repo(first.id, 1),
      repo(first.id, 2),
    ]);
    const [kept] = await repositories.list({ integrationId: first.id });

    const result = await repositories.reconcile(first.id, [repo(first.id, 2)]);

    expect(result.deactivated).toBe(1);
    const all = await repositories.list({ integrationId: first.id });
    expect(all).toHaveLength(2);
    expect(all.find((item) => item.id === kept!.id)).toMatchObject({
      externalId: "1",
      active: false,
    });
    expect(await repositories.list({ active: true })).toHaveLength(1);
  });

  // CR-21-T06
  it("reactivates the same row when a repository comes back", async () => {
    const { first, repositories } = await setup();
    await repositories.reconcile(first.id, [repo(first.id, 1)]);
    const [original] = await repositories.list();
    await repositories.reconcile(first.id, []);

    const result = await repositories.reconcile(first.id, [repo(first.id, 1)]);

    expect(result).toMatchObject({ added: 0, reactivated: 1 });
    expect(await repositories.list()).toEqual([
      { ...original, active: true, updatedAt: expect.any(String) },
    ]);
  });

  it("follows a rename of a repository on the platform", async () => {
    const { first, repositories } = await setup();
    await repositories.reconcile(first.id, [repo(first.id, 1, "acme/old")]);

    const result = await repositories.reconcile(first.id, [
      repo(first.id, 1, "acme/new"),
    ]);

    expect(result.updated).toBe(1);
    expect(await repositories.list()).toMatchObject([
      { fullName: "acme/new", url: "https://github.test/acme/new" },
    ]);
  });

  it("counts a repository once when the platform lists it twice", async () => {
    const { first, repositories } = await setup();

    const result = await repositories.reconcile(first.id, [
      repo(first.id, 1),
      repo(first.id, 1),
    ]);

    expect(result.added).toBe(1);
    expect(await repositories.list()).toHaveLength(1);
  });

  it("leaves the repositories of other integrations alone", async () => {
    const { first, second, repositories } = await setup();
    await repositories.reconcile(second.id, [
      repo(second.id, 1, "octocat/hello"),
    ]);

    await repositories.reconcile(first.id, [repo(first.id, 1)]);
    await repositories.reconcile(first.id, []);

    expect(await repositories.list({ integrationId: second.id })).toMatchObject(
      [{ fullName: "octocat/hello", active: true }],
    );
  });

  it("keeps the same repository of two integrations apart", async () => {
    const { first, second, repositories } = await setup();

    await repositories.reconcile(first.id, [repo(first.id, 1)]);
    await repositories.reconcile(second.id, [repo(second.id, 1)]);

    expect(await repositories.list()).toHaveLength(2);
  });

  it("refuses repositories of an integration that does not exist", async () => {
    const { repositories } = await setup();

    await expect(
      repositories.reconcile("missing", [repo("missing", 1)]),
    ).rejects.toThrow();
    expect(await repositories.list()).toEqual([]);
  });
});

describe("deactivating all repositories of an integration", () => {
  // CR-21-T05
  it("marks every active repository inactive and deletes nothing", async () => {
    const { first, second, repositories } = await setup();
    await repositories.reconcile(first.id, [
      repo(first.id, 1),
      repo(first.id, 2),
      repo(first.id, 3),
    ]);
    await repositories.reconcile(second.id, [repo(second.id, 9, "octocat/x")]);

    const changed = await repositories.deactivateAll(first.id);

    expect(changed).toBe(3);
    expect(await repositories.list({ integrationId: first.id })).toMatchObject([
      { active: false },
      { active: false },
      { active: false },
    ]);
    expect(await repositories.list({ active: true })).toHaveLength(1);
  });
});

describe("the stored rows", () => {
  it("keep ISO timestamps and use 1 and 0 for the flag", async () => {
    const { db, first, repositories } = await setup();
    await repositories.reconcile(first.id, [repo(first.id, 1)]);
    await repositories.deactivateAll(first.id);

    const row = await (db as Kysely<Database>)
      .selectFrom("repositories")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(row.active).toBe(0);
    expect(row.created_at).toMatch(/^2026-10-10T12:00:\d{2}\.000Z$/);
    expect(row.updated_at > row.created_at).toBe(true);
  });
});

describe("finding a repository by the platform's id", () => {
  it("finds the row of that integration and nothing for another integration or an unknown id", async () => {
    const { first, second, repositories } = await setup();
    await repositories.reconcile(first.id, [repo(first.id, 1)]);
    await repositories.reconcile(second.id, [
      repo(second.id, 1, "octocat/hello"),
    ]);

    expect(await repositories.findByExternalId(first.id, "1")).toMatchObject({
      integrationId: first.id,
      fullName: "acme/repo-1",
    });
    expect(await repositories.findByExternalId(second.id, "1")).toMatchObject({
      fullName: "octocat/hello",
    });
    expect(await repositories.findByExternalId(first.id, "99")).toBeUndefined();
  });
});
