// Pins down the real route files `GET /api/runs` and `GET /api/runs/:id` with the wiring the running
// server uses: the database opened at start, the runs service and the user check. Only the session
// lookup and `connection()` are replaced (they need Next.js's request scope). The behavior of the
// handlers is in src/runs/http.ts and the proxy in front is in runs-route.integration.test.ts; this
// file proves the pieces are connected.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { getJobQueue } from "../../src/jobs/shared.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { GET as getList } from "../../src/app/api/runs/route.ts";
import { GET as getOne } from "../../src/app/api/runs/[id]/route.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  requireUser: vi.fn<() => Promise<SessionUser>>(),
}));
vi.mock("@/auth/session", () => ({ requireUser: session.requireUser }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;

async function startRoutes() {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const integration = await createIntegrationsRepository(
    db,
    await defaultWorkspaceId(db),
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    db,
    await defaultWorkspaceId(db),
  );
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
  const result = await getJobQueue().enqueue({
    repositoryId: repository.id,
    prNumber: 3,
    prUrl: "https://github.com/acme/widgets/pull/3",
    headSha: "b".repeat(40),
    command: "review",
    triggerKind: "manual",
    actorLogin: "octocat",
  });
  if (result.status !== "created") throw new Error("seeding failed");
  return { job: result.job };
}

beforeEach(() => {
  session.requireUser.mockResolvedValue(USER);
});

afterEach(async () => {
  await closeDatabase();
});

describe("the runs route files", () => {
  // CR-35-T01
  it("list the runs of the database opened at start", async () => {
    const { job } = await startRoutes();

    const response = await getList(new Request("https://app.test/api/runs"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [{ id: job.id, project: "acme/widgets", status: "queued" }],
    });
  });

  // CR-35-T04, CR-35-T05
  it("answer one run by the id in the address and 404 for an unknown one", async () => {
    const { job } = await startRoutes();
    const ask = (id: string) =>
      getOne(new Request(`https://app.test/api/runs/${id}`), {
        params: Promise.resolve({ id }),
      } as Parameters<typeof getOne>[1]);

    const found = await ask(job.id);
    const missing = await ask("00000000-0000-4000-8000-000000000000");

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ run: { id: job.id } });
    expect(missing.status).toBe(404);
  });

  // CR-35-T16
  it("ask for the user before they read anything, and a refusal reaches the caller", async () => {
    const { job } = await startRoutes();
    const refusal = new Error("NEXT_REDIRECT");
    session.requireUser.mockRejectedValue(refusal);

    await expect(
      getList(new Request("https://app.test/api/runs")),
    ).rejects.toBe(refusal);
    await expect(
      getOne(new Request(`https://app.test/api/runs/${job.id}`), {
        params: Promise.resolve({ id: job.id }),
      } as Parameters<typeof getOne>[1]),
    ).rejects.toBe(refusal);
  });

  it("export only the GET method", async () => {
    const list = await import("../../src/app/api/runs/route.ts");
    const one = await import("../../src/app/api/runs/[id]/route.ts");

    expect(Object.keys(list)).toEqual(["GET"]);
    expect(Object.keys(one)).toEqual(["GET"]);
  });
});
