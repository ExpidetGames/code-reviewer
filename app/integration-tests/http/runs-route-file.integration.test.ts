// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files `GET /api/w/:workspace/runs` and `GET /api/w/:workspace/runs/:id` with the
// wiring the running server uses: the database opened at start, the runs service and the workspace access.
// Only the session lookup and `connection()` are replaced (they need Next.js's request scope). The
// behavior of the handlers is in src/runs/http.ts and the proxy in front is in
// runs-route.integration.test.ts; this file proves the pieces are connected, and that the workspace comes
// from the address and from the membership of the person, not from anywhere else.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { jobQueueFor } from "../../src/jobs/shared.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { GET as getList } from "../../src/app/api/w/[workspace]/runs/route.ts";
import { GET as getOne } from "../../src/app/api/w/[workspace]/runs/[id]/route.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

async function startRoutes() {
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, { workspaceId, role: "member" }),
  );
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "1",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const result = await jobQueueFor(workspaceId).enqueue({
    repositoryId: repository.id,
    prNumber: 3,
    prUrl: "https://github.com/acme/widgets/pull/3",
    headSha: "b".repeat(40),
    command: "review",
    triggerKind: "manual",
    actorLogin: "octocat",
  });
  if (result.status !== "created") throw new Error("seeding failed");
  return { job: result.job, db, workspaceId };
}

const list = (workspace: string) =>
  getList(new Request(`https://app.test/api/w/${workspace}/runs`), {
    params: Promise.resolve({ workspace }),
  } as Parameters<typeof getList>[1]);
const one = (workspace: string, id: string) =>
  getOne(new Request(`https://app.test/api/w/${workspace}/runs/${id}`), {
    params: Promise.resolve({ workspace, id }),
  } as Parameters<typeof getOne>[1]);

afterEach(async () => {
  await closeDatabase();
});

describe("the runs route files", () => {
  // CR-35-T01
  it("list the runs of the workspace in the address", async () => {
    const { job } = await startRoutes();

    const response = await list("default");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [{ id: job.id, project: "acme/widgets", status: "queued" }],
    });
  });

  // CR-35-T04, CR-35-T05
  it("answer one run by the id in the address and 404 for an unknown one", async () => {
    const { job } = await startRoutes();

    const found = await one("default", job.id);
    const missing = await one(
      "default",
      "00000000-0000-4000-8000-000000000000",
    );

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ run: { id: job.id } });
    expect(missing.status).toBe(404);
  });

  // #101-WM-06, #101-WM-07
  it("answer a workspace the person does not belong to like one that does not exist, and show nothing of it", async () => {
    const { job, db } = await startRoutes();
    await signedInMember(db, { id: "outsider" });
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const response of [
      await list("default"),
      await list("no-such-workspace"),
      await one("default", job.id),
      await one("no-such-workspace", job.id),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  // CR-35-T16
  it("ask for the session before they read anything, and answer a visitor with 401", async () => {
    const { job } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const responses = [await list("default"), await one("default", job.id)];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    }
  });

  it("export only the GET method", async () => {
    const listRoute =
      await import("../../src/app/api/w/[workspace]/runs/route.ts");
    const oneRoute =
      await import("../../src/app/api/w/[workspace]/runs/[id]/route.ts");

    expect(Object.keys(listRoute)).toEqual(["GET"]);
    expect(Object.keys(oneRoute)).toEqual(["GET"]);
  });
});
