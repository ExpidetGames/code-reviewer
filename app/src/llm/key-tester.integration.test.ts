// SPDX-License-Identifier: Apache-2.0

// The "test key" service exactly as the running server wires it (`createWiredLlmKeyTester`, #588), over a real database: the
// pins of the workspace's projects reach the test, only the projects that use the provider count, and a refusal sends nothing.
// A change that leaves the pins out of the wiring turns these red; the pieces alone (key-test.test.ts) would not.
import { describe, expect, it, vi } from "vitest";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import {
  seedRepositories,
  setupReviewSettings,
} from "../test-support/review-settings-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWiredLlmKeyTester } from "./key-tester.ts";

const T1 = "2026-10-19T03:00:00.000Z";
const KEY = "sk-deepseek-typed-0123456789abcdef";
const PINNED = "https://api.deepseek.example";
const MOVED = "https://api.deepseek-moved.example";

async function setup() {
  const app = await setupReviewSettings();
  await createModelsDevRepository(app.db).apply({
    providers: [
      {
        id: "deepseek",
        name: "deepseek",
        url: {
          state: "trusted",
          trustedUrl: MOVED,
          pendingUrl: null,
          problem: null,
        },
        urlChangedAt: null,
        firstSeenAt: T1,
        unlistedAt: null,
        updatedAt: T1,
      },
    ],
    models: [],
  });
  const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}")));
  const tester = createWiredLlmKeyTester({
    db: app.db,
    env: () => ({}),
    fetchImpl,
  });
  const pin = (
    projects: typeof app.projects,
    repositoryId: string,
    settings: Record<string, string>,
    active = true,
  ) =>
    projects
      .updateSettingsWith(repositoryId, () => ({
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
        dynamicProviderAddress: PINNED,
        ...settings,
      }))
      .then(() => (active ? projects.activate(repositoryId) : undefined));
  const test = () =>
    tester.test({
      workspaceId: app.workspaceId,
      provider: "deepseek",
      apiKey: KEY,
    });
  return { ...app, tester, fetchImpl, pin, test };
}

const ADDRESS_CHANGED = {
  ok: false,
  error: "llm_provider_address_changed",
  detail: null,
};

describe("the key test as the server wires it, held to the pins of the workspace (#588)", () => {
  // #588-T48
  it("sends nothing when a project that uses the provider pinned another address than the catalog trusts now", async () => {
    const t = await setup();
    await t.pin(t.projects, t.first.id, { reviewKind: "dynamic" });

    expect(await t.test()).toEqual(ADDRESS_CHANGED);
    expect(
      await t.tester.preflight({
        workspaceId: t.workspaceId,
        provider: "deepseek",
      }),
    ).toEqual(ADDRESS_CHANGED);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  // #588-T48
  it("tests the key at the trusted address once the pin is that address, or there is no pin", async () => {
    const t = await setup();
    await t.pin(t.projects, t.first.id, {
      reviewKind: "dynamic",
      dynamicProviderAddress: MOVED,
    });
    expect(await t.test()).toMatchObject({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);

    const none = await setup();
    expect(await none.test()).toMatchObject({ ok: true });
    expect(none.fetchImpl).toHaveBeenCalledTimes(1);
  });

  // #588-T49
  it("ignores the pins of projects that do not use the provider: Diff Review, switched off, another workspace", async () => {
    const t = await setup();
    await t.pin(t.projects, t.first.id, { reviewKind: "diff" });
    await t.pin(t.projects, t.second.id, { reviewKind: "dynamic" }, false);
    const otherWorkspace = await addWorkspace(t.db, "beta");
    const other = await seedRepositories(t.db, otherWorkspace, "9999");
    const otherProjects = createProjectsRepository(t.db, otherWorkspace);
    await t.pin(otherProjects, other.first.id, { reviewKind: "dynamic" });

    expect(await t.test()).toMatchObject({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
