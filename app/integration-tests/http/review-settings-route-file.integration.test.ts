// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files of the review settings with the wiring the running server uses: the
// dynamic segments, the database opened at start, the service on top of it and the workspace access. Only
// the session lookup and `connection()` are replaced (they need Next.js's request scope). The behavior of
// the handlers is in src/review-settings/http.integration.test.ts and the proxy in front is in
// review-settings-route.integration.test.ts; this file proves the pieces are connected, that the defaults
// of a workspace are for Admins and Owners and the settings of a project for every member, and that the
// workspace is the one in the address.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { createModelsDevRepository } from "../../src/db/repositories/models-dev-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { seedRepositories } from "../../src/test-support/review-settings-harness.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  DELETE,
  GET as GET_PROJECT,
  PUT as PUT_PROJECT,
} from "../../src/app/api/w/[workspace]/repositories/[repositoryId]/project/settings/route.ts";
import {
  GET as GET_GLOBAL,
  PUT as PUT_GLOBAL,
} from "../../src/app/api/w/[workspace]/review-settings/route.ts";
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
  const { first, second } = await seedRepositories(db);
  const workspaceId = await defaultWorkspaceId(db);
  await createProjectsRepository(db, workspaceId).activate(first.id);
  const signIn = async (role: "owner" | "admin" | "member", id = `${role}-1`) =>
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, {
        id,
        workspaceId,
        role,
        githubLogin: "octocat",
      }),
    );
  await signIn("admin");
  const context = (repositoryId: string, workspace = "default") =>
    ({ params: Promise.resolve({ workspace, repositoryId }) }) as Parameters<
      typeof PUT_PROJECT
    >[1];
  const globalContext = (workspace = "default") =>
    ({ params: Promise.resolve({ workspace }) }) as Parameters<
      typeof PUT_GLOBAL
    >[1];
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, first, second, context, globalContext, request, signIn };
}

afterEach(async () => {
  await closeDatabase();
});

describe("the global review settings route", () => {
  it("saves the defaults and reads them back", async () => {
    const { request, globalContext } = await startRoutes();
    const path = "/api/w/default/review-settings";

    const put = await PUT_GLOBAL(
      request("PUT", path, { settings: { maxFindings: 7 } }),
      globalContext(),
    );
    const get = await GET_GLOBAL(request("GET", path), globalContext());

    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({
      overrides: { maxFindings: 7 },
      updatedBy: "octocat",
    });
  });

  // #101-WM-08
  it("lets a Member read the defaults and refuses them to change them", async () => {
    const { request, globalContext, signIn, db } = await startRoutes();
    await signIn("member");
    const path = "/api/w/default/review-settings";

    const get = await GET_GLOBAL(request("GET", path), globalContext());
    const put = await PUT_GLOBAL(
      request("PUT", path, { settings: { maxFindings: 7 } }),
      globalContext(),
    );

    expect(get.status).toBe(200);
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "forbidden" });
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });

  // #101-WM-06, #101-WM-07
  it("answers a workspace the person does not belong to like one that does not exist", async () => {
    const { request, globalContext, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "nothing"]) {
      const path = `/api/w/${workspace}/review-settings`;
      for (const response of [
        await GET_GLOBAL(request("GET", path), globalContext(workspace)),
        await PUT_GLOBAL(
          request("PUT", path, { settings: {} }),
          globalContext(workspace),
        ),
      ]) {
        expect(response.status, workspace).toBe(404);
        expect(await response.json(), workspace).toEqual({
          error: "not_found",
        });
      }
    }
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });

  it("asks for the session before it does anything", async () => {
    const { request, db, globalContext } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await PUT_GLOBAL(
      request("PUT", "/api/w/default/review-settings", { settings: {} }),
      globalContext(),
    );

    expect(response.status).toBe(401);
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });
});

describe("the project review settings route", () => {
  it("saves, reads and resets the overrides of the project in the URL", async () => {
    const { request, context, first, db } = await startRoutes();
    const path = `/api/w/default/repositories/${first.id}/project/settings`;

    const put = await PUT_PROJECT(
      request("PUT", path, { settings: { maxFindings: 2 } }),
      context(first.id),
    );
    const get = await GET_PROJECT(request("GET", path), context(first.id));
    const reset = await DELETE(request("DELETE", path), context(first.id));

    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({ overrides: { maxFindings: 2 } });
    expect(await reset.json()).toMatchObject({ overrides: {} });
    expect(
      (await db.selectFrom("projects").selectAll().execute())[0]?.settings,
    ).toBe("{}");
  });

  // #101-WM-08
  it("lets a Member change the settings of a project", async () => {
    const { request, context, first, signIn } = await startRoutes();
    await signIn("member");

    const put = await PUT_PROJECT(
      request(
        "PUT",
        `/api/w/default/repositories/${first.id}/project/settings`,
        { settings: { maxFindings: 3 } },
      ),
      context(first.id),
    );

    expect(put.status).toBe(200);
  });

  // #101-WM-07
  it("answers 404 for the project of a workspace the person does not belong to, and changes nothing", async () => {
    const { request, context, first, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );
    const before = await db.selectFrom("projects").selectAll().execute();

    const responses = [
      await PUT_PROJECT(
        request(
          "PUT",
          `/api/w/default/repositories/${first.id}/project/settings`,
          { settings: { maxFindings: 3 } },
        ),
        context(first.id),
      ),
      await GET_PROJECT(
        request(
          "GET",
          `/api/w/default/repositories/${first.id}/project/settings`,
        ),
        context(first.id),
      ),
      await DELETE(
        request(
          "DELETE",
          `/api/w/default/repositories/${first.id}/project/settings`,
        ),
        context(first.id),
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(await db.selectFrom("projects").selectAll().execute()).toEqual(
      before,
    );
  });

  it("answers 404 for a repository that has no project", async () => {
    const { request, context } = await startRoutes();

    const response = await PUT_PROJECT(
      request("PUT", "/api/w/default/repositories/nope/project/settings", {
        settings: {},
      }),
      context("nope"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    });
  });
});

// Who may confirm or move the address pinned for a catalog provider (#588), through the real route files: the role of the person
// reaches the service as `manage_llm_key`, so a Member who tries any of the ways around the confirmation is refused with a 403 and
// the stored pin stays, while an Admin and an Owner may.
describe("the pinned address of a catalog provider on the project route (#588)", () => {
  const T1 = "2026-10-19T03:00:00.000Z";
  const DEEPSEEK = "https://api.deepseek.example";
  const MOVED = "https://api.deepseek-moved.example";
  const SELECT = {
    reviewKind: "dynamic",
    dynamicProvider: "deepseek",
    dynamicModel: "deepseek-v4-pro",
  };

  async function start() {
    const routes = await startRoutes();
    await createProjectsRepository(
      routes.db,
      await defaultWorkspaceId(routes.db),
    ).activate(routes.second.id);
    const repository = createModelsDevRepository(routes.db);
    const provider = {
      id: "deepseek",
      name: "deepseek",
      url: {
        state: "trusted" as const,
        trustedUrl: DEEPSEEK,
        pendingUrl: null,
        problem: null,
      },
      urlChangedAt: null,
      firstSeenAt: T1,
      unlistedAt: null,
      updatedAt: T1,
    };
    await repository.apply({
      providers: [provider],
      models: [
        {
          providerId: "deepseek",
          id: "deepseek-v4-pro",
          name: "deepseek-v4-pro",
          family: null,
          limit: { context: 128_000, output: 8_000 },
          reasoning: false,
          temperature: true,
          attachment: false,
          modalities: { input: ["text"], output: ["text"] },
          status: null,
          cost: { input: "0.66", output: "1.98" },
          lastUpdated: null,
          interleaved: null,
          firstSeenAt: T1,
          unlistedAt: null,
          updatedAt: T1,
        },
      ],
    });
    const path = (repositoryId: string) =>
      `/api/w/default/repositories/${repositoryId}/project/settings`;
    const put = (repositoryId: string, settings: unknown) =>
      PUT_PROJECT(
        routes.request("PUT", path(repositoryId), { settings }),
        routes.context(repositoryId),
      );
    const reset = (repositoryId: string) =>
      DELETE(
        routes.request("DELETE", path(repositoryId)),
        routes.context(repositoryId),
      );
    const pinOf = async (repositoryId: string) => {
      const rows = await routes.db.selectFrom("projects").selectAll().execute();
      const row = rows.find((r) => r.repository_id === repositoryId);
      return (
        JSON.parse(row?.settings ?? "{}") as {
          dynamicProviderAddress?: string;
        }
      ).dynamicProviderAddress;
    };
    const moveAddress = () =>
      repository.apply({
        providers: [
          { ...provider, url: { ...provider.url, trustedUrl: MOVED } },
        ],
        models: [],
      });
    return { ...routes, put, reset, pinOf, moveAddress };
  }

  // #588-T43
  it("refuses a Member every way to move a pin that differs from what the catalog trusts, and keeps the pin", async () => {
    const app = await start();
    await app.signIn("member");
    expect((await app.put(app.first.id, SELECT)).status).toBe(200);
    expect(await app.pinOf(app.first.id)).toBe(DEEPSEEK);
    await app.moveAddress();

    // The last one writes a pin another project holds differently: its own code since #614, the same 403.
    const refused = [
      [
        await app.put(app.first.id, { confirmProviderAddress: true }),
        "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN",
      ],
      [
        await app.put(app.first.id, {
          dynamicProvider: null,
          dynamicModel: null,
        }),
        "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN",
      ],
      [await app.reset(app.first.id), "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN"],
      [
        await app.put(app.second.id, SELECT),
        "PROVIDER_ADDRESS_OTHER_PROJECT_PIN",
      ],
    ] as const;

    for (const [response, error] of refused) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error });
    }
    expect(await app.pinOf(app.first.id)).toBe(DEEPSEEK);
    expect(await app.pinOf(app.second.id)).toBeUndefined();
  });

  // #588-T44
  it.each(["admin", "owner"] as const)(
    "lets an %s confirm the moved address, and select the provider in another project at it",
    async (role) => {
      const app = await start();
      await app.signIn("member");
      expect((await app.put(app.first.id, SELECT)).status).toBe(200);
      await app.moveAddress();
      await app.signIn(role);

      const confirmed = await app.put(app.first.id, {
        confirmProviderAddress: true,
      });
      const other = await app.put(app.second.id, SELECT);

      expect(confirmed.status).toBe(200);
      expect(other.status).toBe(200);
      expect(await app.pinOf(app.first.id)).toBe(MOVED);
      expect(await app.pinOf(app.second.id)).toBe(MOVED);
    },
  );
});
