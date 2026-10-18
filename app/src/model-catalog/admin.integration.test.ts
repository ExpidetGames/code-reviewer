// SPDX-License-Identifier: Apache-2.0

// The model catalog in the admin portal (#429), end to end over a real database, the real access proxy and the real data
// routes, with the capability checks answered by the fake LLM: only an instance admin gets in, every change comes from
// this site and is JSON, an entry is created, checked and released, every refusal is a stable code with its status, a
// retired entry stays listed, and changing the model behind a released entry needs a confirmation and writes an audit line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import {
  MISSING_ANSWER_MARKER,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import {
  CATALOG_ROUTE_ERROR_CODES,
  CATALOG_ROUTE_ERROR_STATUS,
} from "./admin-errors.ts";

const BASE = "/api/admin/model-catalog";
const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const TOOLS = { supported_parameters: ["tools", "tool_choice"] };
const NO_TOOLS = { supported_parameters: ["temperature"] };

const SMALL = {
  name: "Small",
  description: "Quick reviews that point out the obvious problems.",
  provider: "openrouter",
  modelId: "acme/quick-1",
  kinds: ["diff"],
};

async function start() {
  const llm = await startLlmFake();
  cleanUpAfterTest(() => llm.close());
  llm.setModel("acme/quick-1", [TOOLS]);
  llm.setModel("acme/better-2", [TOOLS]);
  llm.setModel("acme/no-tools", [NO_TOOLS]);
  const portal = await createAdminHarness({ llm });
  return { portal, llm };
}

function call(
  portal: AdminHarness,
  method: string,
  path: string,
  body?: unknown,
  cookies = portal.adminCookies,
  headers?: Record<string, string>,
) {
  return portal.visit(`${BASE}${path}`, {
    method,
    cookies,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });
}

type Entry = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  status: string;
  kinds: string[];
  sortOrder: number;
  usedByProjects: number;
};
type Catalog = {
  entries: Entry[];
  defaults: { diff: string | null; dynamic: string | null };
  providers: Array<{ id: string; label: string }>;
};

async function catalogOf(portal: AdminHarness): Promise<Catalog> {
  const response = await call(portal, "GET", "");
  expect(response.status).toBe(200);
  return (await response.json()) as Catalog;
}

async function createEntry(
  portal: AdminHarness,
  input: Record<string, unknown> = SMALL,
): Promise<Entry> {
  const response = await call(portal, "POST", "", input);
  const answer = (await response.json()) as { entry: Entry };
  expect(response.status).toBe(200);
  return answer.entry;
}

async function releaseEntry(portal: AdminHarness, id: string) {
  const response = await call(portal, "POST", `/${id}/release`, {});
  expect(response.status).toBe(200);
}

function isHidden(response: Response): boolean {
  return (
    response.status === 404 &&
    response.headers.get(MISSING_ANSWER_MARKER) === "1"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const WRITES: Array<{ method: string; path: string; body: unknown }> = [
  { method: "POST", path: "", body: SMALL },
  { method: "PUT", path: "/mce_x", body: { name: "Other" } },
  { method: "DELETE", path: "/mce_x", body: {} },
  { method: "POST", path: "/mce_x/release", body: {} },
  { method: "POST", path: "/mce_x/retire", body: {} },
  { method: "PUT", path: "/defaults", body: { diff: null, dynamic: null } },
  {
    method: "POST",
    path: "/check",
    body: { provider: "openrouter", modelId: "acme/quick-1", kinds: ["diff"] },
  },
];
const ROUTES = [{ method: "GET", path: "", body: undefined }, ...WRITES];

describe("who may use the catalog routes", () => {
  // #429-T01
  it.each(ROUTES)(
    "gives 401 to a visitor without a session on $method /model-catalog$path",
    async ({ method, path, body }) => {
      const { portal } = await start();

      const response = await call(portal, method, path, body, new Map());

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect((await portal.catalog.list()).length).toBe(0);
    },
  );

  // #429-T01
  it.each(ROUTES)(
    "hides $method /model-catalog$path from a signed in person who is not an admin, with and without the proxy",
    async ({ method, path, body }) => {
      const { portal } = await start();
      await portal.createUser({ id: "member-1", ...MEMBER });
      const member = await portal.signIn(MEMBER.email, MEMBER.password);

      const proxied = await call(portal, method, path, body, member);
      const direct = await portal.callRoute(
        `/api/instance-portal/model-catalog${path}`,
        { method, cookies: member, ...(body === undefined ? {} : { body }) },
      );

      expect(isHidden(proxied)).toBe(true);
      expect(direct.status).toBe(404);
      expect((await portal.catalog.list()).length).toBe(0);
    },
  );

  // #429-T01
  it.each(WRITES)(
    "refuses $method /model-catalog$path from another site, a body that is not JSON and a body over 64 KB",
    async ({ method, path, body }) => {
      const { portal } = await start();
      const before = await portal.catalog.list();

      const crossSite = await call(portal, method, path, body, undefined, {
        "sec-fetch-site": "cross-site",
      });
      const plain = await call(portal, method, path, "name=x", undefined, {
        "content-type": "text/plain",
      });
      const huge = await call(
        portal,
        method,
        path,
        JSON.stringify({ name: "x".repeat(70 * 1024) }),
        undefined,
        { "content-type": "application/json" },
      );

      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
      expect(plain.status).toBe(415);
      expect(await plain.json()).toEqual({ error: "unsupported_content_type" });
      expect(huge.status).toBe(413);
      expect(await huge.json()).toEqual({ error: "body_too_large" });
      expect(await portal.catalog.list()).toEqual(before);
    },
  );

  // #429-T01
  it("answers every route with Cache-Control: no-store", async () => {
    const { portal } = await start();
    const entry = await createEntry(portal);

    const answers = [
      await call(portal, "GET", ""),
      await call(portal, "PUT", `/${entry.id}`, { name: "Tiny" }),
      await call(portal, "POST", `/${entry.id}/release`, {}),
      await call(portal, "PUT", "/defaults", {
        diff: "mce_none",
        dynamic: null,
      }),
    ];

    for (const answer of answers)
      expect(answer.headers.get("cache-control")).toBe("no-store");
  });
});

describe("creating, checking and releasing an entry", () => {
  // #429-T02
  it("creates a draft, checks the model against the provider's metadata and releases it", async () => {
    const { portal, llm } = await start();
    expect(await catalogOf(portal)).toMatchObject({
      entries: [],
      defaults: { diff: null, dynamic: null },
      providers: [{ id: "openrouter" }],
    });

    const created = await call(portal, "POST", "", SMALL);
    const draft = ((await created.json()) as { entry: Entry }).entry;
    expect(draft).toMatchObject({
      name: "Small",
      status: "draft",
      provider: "openrouter",
      modelId: "acme/quick-1",
      kinds: ["diff"],
      usedByProjects: 0,
    });
    expect(draft.id).toMatch(/^mce_[0-9a-f]{32}$/);
    // Creating asks nobody: a draft is not checked until it is released.
    expect(llm.modelRequests()).toEqual([]);

    const checked = await call(portal, "POST", "/check", {
      provider: "openrouter",
      modelId: "acme/quick-1",
      kinds: ["diff", "dynamic"],
    });
    expect(await checked.json()).toEqual({ ok: true, verified: true });
    expect(llm.modelRequests().length).toBeGreaterThan(0);

    const released = await call(portal, "POST", `/${draft.id}/release`, {});
    expect(released.status).toBe(200);
    expect(((await released.json()) as { entry: Entry }).entry.status).toBe(
      "released",
    );
    expect((await catalogOf(portal)).entries).toMatchObject([
      { id: draft.id, status: "released" },
    ]);
    // What a member of a workspace gets of it: the name, never the model.
    expect(await portal.catalog.memberEntries()).toEqual([
      expect.objectContaining({ id: draft.id, name: "Small" }),
    ]);
    expect(JSON.stringify(await portal.catalog.memberEntries())).not.toContain(
      "acme/quick-1",
    );
  });

  // #429-T02
  it("says what the check found when the provider cannot vouch for the model", async () => {
    const { portal } = await start();

    const answer = async (modelId: string, kinds: string[]) =>
      (
        await call(portal, "POST", "/check", {
          provider: "openrouter",
          modelId,
          kinds,
        })
      ).json();

    expect(await answer("acme/no-tools", ["dynamic"])).toEqual({
      ok: false,
      error: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
    });
    expect(await answer("acme/unheard-of", ["diff"])).toEqual({
      ok: false,
      error: "MODEL_UNKNOWN",
    });
    expect(await answer("acme/no-tools", ["diff"])).toEqual({
      ok: true,
      verified: true,
    });
  });

  // #429-T02
  it("sets a released entry as the default of a kind, clears it, and lists the defaults", async () => {
    const { portal } = await start();
    const entry = await createEntry(portal, {
      ...SMALL,
      kinds: ["diff", "dynamic"],
    });
    await releaseEntry(portal, entry.id);

    const set = await call(portal, "PUT", "/defaults", {
      diff: entry.id,
      dynamic: entry.id,
    });
    expect(set.status).toBe(200);
    expect((await catalogOf(portal)).defaults).toEqual({
      diff: entry.id,
      dynamic: entry.id,
    });

    await call(portal, "PUT", "/defaults", { diff: null, dynamic: entry.id });
    expect((await catalogOf(portal)).defaults).toEqual({
      diff: null,
      dynamic: entry.id,
    });
  });

  // #429-T02
  it("deletes a draft", async () => {
    const { portal } = await start();
    const entry = await createEntry(portal);

    const removed = await call(portal, "DELETE", `/${entry.id}`, {});

    expect(removed.status).toBe(200);
    expect((await catalogOf(portal)).entries).toEqual([]);
  });

  // #429-T02
  it("changes the order of the entries with their sort order", async () => {
    const { portal } = await start();
    const first = await createEntry(portal);
    const second = await createEntry(portal, {
      ...SMALL,
      name: "Medium",
      modelId: "acme/better-2",
    });

    await call(portal, "PUT", `/${second.id}`, { sortOrder: -1 });

    expect((await catalogOf(portal)).entries.map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  // #429-T02
  it("counts the projects that use each entry, a number and nothing else", async () => {
    const { portal } = await start();
    const entry = await createEntry(portal);
    await seedProjects(portal, entry.id, 2);

    const catalog = await catalogOf(portal);

    expect(catalog.entries[0]?.usedByProjects).toBe(2);
  });
});

describe("a refused change", () => {
  type Case = {
    name: string;
    code: string;
    field?: string;
    run: (portal: AdminHarness) => Promise<Response>;
  };
  const refusals: Case[] = [
    {
      name: "a name that is empty",
      code: "name_invalid",
      field: "name",
      run: (portal) => call(portal, "POST", "", { ...SMALL, name: "  " }),
    },
    {
      name: "a name that gives the model away",
      code: "name_reveals_model",
      field: "name",
      run: (portal) =>
        call(portal, "POST", "", { ...SMALL, name: "Quick 1 by acme/quick-1" }),
    },
    {
      name: "a name that is taken, whatever the case",
      code: "catalog_name_taken",
      run: async (portal) => {
        await createEntry(portal);
        return call(portal, "POST", "", { ...SMALL, name: "SMALL" });
      },
    },
    {
      name: "a description that speaks of a price",
      code: "description_invalid",
      field: "description",
      run: (portal) =>
        call(portal, "POST", "", {
          ...SMALL,
          description: "Costs $3 per run.",
        }),
    },
    {
      name: "a provider that is not registered",
      code: "PROVIDER_UNKNOWN",
      field: "provider",
      run: (portal) =>
        call(portal, "POST", "", { ...SMALL, provider: "nowhere" }),
    },
    {
      name: "a model id the provider's rule refuses",
      code: "model_id_invalid",
      field: "modelId",
      run: (portal) =>
        call(portal, "POST", "", { ...SMALL, modelId: "has a space" }),
    },
    {
      name: "no kind",
      code: "kinds_invalid",
      field: "kinds",
      run: (portal) => call(portal, "POST", "", { ...SMALL, kinds: [] }),
    },
    {
      name: "an update of an entry that does not exist",
      code: "CATALOG_ENTRY_UNKNOWN",
      run: (portal) => call(portal, "PUT", "/mce_nothing", { name: "Other" }),
    },
    {
      name: "retiring a draft",
      code: "catalog_transition_invalid",
      run: async (portal) => {
        const entry = await createEntry(portal);
        return call(portal, "POST", `/${entry.id}/retire`, {});
      },
    },
    {
      name: "deleting a released entry",
      code: "catalog_entry_not_draft",
      run: async (portal) => {
        const entry = await createEntry(portal);
        await releaseEntry(portal, entry.id);
        return call(portal, "DELETE", `/${entry.id}`, {});
      },
    },
    {
      name: "retiring the default of a kind",
      code: "catalog_entry_is_default",
      run: async (portal) => {
        const entry = await createEntry(portal);
        await releaseEntry(portal, entry.id);
        await call(portal, "PUT", "/defaults", {
          diff: entry.id,
          dynamic: null,
        });
        return call(portal, "POST", `/${entry.id}/retire`, {});
      },
    },
    {
      name: "a default that is still a draft",
      code: "CATALOG_ENTRY_NOT_RELEASED",
      field: "diff",
      run: async (portal) => {
        const entry = await createEntry(portal);
        return call(portal, "PUT", "/defaults", {
          diff: entry.id,
          dynamic: null,
        });
      },
    },
    {
      name: "a default for a kind the entry does not serve",
      code: "CATALOG_ENTRY_KIND_MISMATCH",
      field: "dynamic",
      run: async (portal) => {
        const entry = await createEntry(portal);
        await releaseEntry(portal, entry.id);
        return call(portal, "PUT", "/defaults", {
          diff: null,
          dynamic: entry.id,
        });
      },
    },
    {
      name: "releasing a Dynamic entry whose model has no tool support",
      code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      run: async (portal) => {
        const entry = await createEntry(portal, {
          ...SMALL,
          modelId: "acme/no-tools",
          kinds: ["dynamic"],
        });
        return call(portal, "POST", `/${entry.id}/release`, {});
      },
    },
    {
      name: "releasing a model the provider does not know",
      code: "MODEL_UNKNOWN",
      run: async (portal) => {
        const entry = await createEntry(portal, {
          ...SMALL,
          modelId: "acme/unheard-of",
        });
        return call(portal, "POST", `/${entry.id}/release`, {});
      },
    },
    {
      name: "a body that is not an entry",
      code: "invalid_input",
      run: (portal) => call(portal, "POST", "", "[1, 2]"),
    },
  ];

  // #429-T03
  it.each(refusals)(
    "answers $name with the code $code, its status, the field and nothing written",
    async ({ code, field, run }) => {
      const { portal } = await start();

      const response = await run(portal);
      const answer = (await response.json()) as {
        error: string;
        issues?: Array<{ field: string; code: string }>;
      };

      expect(answer.error).toBe(code);
      expect(response.status).toBe(
        CATALOG_ROUTE_ERROR_STATUS[
          code as (typeof CATALOG_ROUTE_ERROR_CODES)[number]
        ],
      );
      if (field !== undefined) expect(answer.issues).toEqual([{ field, code }]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // The model id of an entry is not in a refusal, whatever the refusal is.
      expect(JSON.stringify(answer)).not.toContain("acme/");
    },
  );

  // #429-T03
  it("gives every code a status and a different one only where the meaning differs", () => {
    for (const code of CATALOG_ROUTE_ERROR_CODES) {
      const status = CATALOG_ROUTE_ERROR_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  // #429-T03
  it("serves nothing from a failing database, with a code and no text of the failure", async () => {
    const { portal } = await start();
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(portal.catalog, "list").mockRejectedValue(
      new Error("connection refused at postgres://user:secret@host/db"),
    );

    const response = await call(portal, "GET", "");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(errors.mock.calls.flat().join(" ")).not.toContain("secret@host");
  });
});

describe("the overview of the portal", () => {
  // #429-T06
  it("reads how many entries are released for each kind and whether it has a default, and no name, provider or model", async () => {
    const { portal } = await start();
    const both = await createEntry(portal, {
      ...SMALL,
      kinds: ["diff", "dynamic"],
    });
    const draft = await createEntry(portal, {
      ...SMALL,
      name: "Draft",
      modelId: "acme/better-2",
    });
    await releaseEntry(portal, both.id);
    await call(portal, "PUT", "/defaults", { diff: both.id, dynamic: null });

    const response = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    const text = await response.text();
    const settings = JSON.parse(text) as { modelCatalog: unknown };

    expect(settings.modelCatalog).toEqual({
      diff: { released: 1, hasDefault: true },
      dynamic: { released: 1, hasDefault: false },
    });
    for (const secret of [both.id, draft.id, "acme/", "Draft", "Small"])
      expect(text).not.toContain(secret);
  });
});

describe("a retired entry", () => {
  // #429-T05
  it("stays listed for the admin, can be released again, and is no longer a default", async () => {
    const { portal } = await start();
    const entry = await createEntry(portal);
    await releaseEntry(portal, entry.id);

    const retired = await call(portal, "POST", `/${entry.id}/retire`, {});

    expect(retired.status).toBe(200);
    expect((await catalogOf(portal)).entries).toMatchObject([
      {
        id: entry.id,
        name: "Small",
        status: "retired",
        modelId: "acme/quick-1",
      },
    ]);
    const again = await call(portal, "POST", `/${entry.id}/release`, {});
    expect(again.status).toBe(200);
    expect((await catalogOf(portal)).entries[0]?.status).toBe("released");
  });
});

/** Makes `count` projects (one or two: the fixture has two repositories) select the entry for Diff. */
async function seedProjects(
  portal: AdminHarness,
  entryId: string,
  count: 1 | 2,
) {
  const fixture = await createJobQueueFixture({ database: portal.db });
  const repositories = [fixture.repositoryId, fixture.otherRepositoryId];
  for (const [index, repositoryId] of repositories.slice(0, count).entries())
    await portal.db
      .insertInto("projects")
      .values({
        id: `p${String(index)}`,
        repository_id: repositoryId,
        active: 1,
        settings: JSON.stringify({ catalogEntryDiff: entryId }),
        created_at: "2026-10-17T10:00:00.000Z",
        updated_at: "2026-10-17T10:00:00.000Z",
      })
      .execute();
}

describe("changing the model behind a released entry", () => {
  async function releasedEntryUsedBy(projects: 1 | 2) {
    const app = await start();
    const entry = await createEntry(app.portal);
    await releaseEntry(app.portal, entry.id);
    await seedProjects(app.portal, entry.id, projects);
    return { ...app, entry };
  }

  // #429-T09
  it("asks for a confirmation that carries the project count, and changes nothing until it is given", async () => {
    const { portal, entry } = await releasedEntryUsedBy(2);

    const refused = await call(portal, "PUT", `/${entry.id}`, {
      modelId: "acme/better-2",
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "model_change_not_confirmed",
      projects: 2,
    });
    expect((await portal.catalog.get(entry.id))?.modelId).toBe("acme/quick-1");
    expect(portal.catalogLog).toEqual([]);
  });

  // #429-T09
  it("changes the model after the confirmation, re-checks it, writes an audit line and answers with the count", async () => {
    const { portal, llm, entry } = await releasedEntryUsedBy(2);
    llm.setModel("acme/better-2", [TOOLS]);

    const changed = await call(portal, "PUT", `/${entry.id}`, {
      modelId: "acme/better-2",
      confirmModelChange: true,
    });

    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      ok: true,
      entry: { id: entry.id, modelId: "acme/better-2", status: "released" },
      modelChange: { projects: 2 },
    });
    expect(portal.catalogLog).toHaveLength(1);
    const line = portal.catalogLog[0] ?? "";
    expect(line).toContain(entry.id);
    expect(line).toContain(portal.adminId);
    expect(line).toContain("acme/quick-1");
    expect(line).toContain("acme/better-2");
    expect(line).toContain("2 projects");
    expect(llm.modelRequests().map((request) => request.path)).toContainEqual(
      expect.stringContaining("better-2"),
    );
  });

  // #429-T09
  it("refuses a confirmed change to a model the provider cannot vouch for, and keeps the model", async () => {
    const { portal, entry } = await releasedEntryUsedBy(1);

    const response = await call(portal, "PUT", `/${entry.id}`, {
      modelId: "acme/unheard-of",
      confirmModelChange: true,
    });

    expect((await response.json()) as { error: string }).toEqual({
      error: "MODEL_UNKNOWN",
    });
    expect((await portal.catalog.get(entry.id))?.modelId).toBe("acme/quick-1");
    expect(portal.catalogLog).toEqual([]);
  });

  // #429-T09
  it("needs no confirmation for a change that leaves the model alone, or for a draft", async () => {
    const { portal, entry } = await releasedEntryUsedBy(2);
    const draft = await createEntry(portal, {
      ...SMALL,
      name: "Draft",
      modelId: "acme/better-2",
    });

    const renamed = await call(portal, "PUT", `/${entry.id}`, {
      name: "Tiny",
      description: null,
    });
    const draftChanged = await call(portal, "PUT", `/${draft.id}`, {
      modelId: "acme/quick-1",
    });

    expect(renamed.status).toBe(200);
    expect(draftChanged.status).toBe(200);
    expect(portal.catalogLog).toEqual([]);
  });

  // #429-T09
  it("takes only a boolean true as the confirmation", async () => {
    const { portal, entry } = await releasedEntryUsedBy(1);

    const response = await call(portal, "PUT", `/${entry.id}`, {
      modelId: "acme/better-2",
      confirmModelChange: "yes",
    });

    expect(response.status).toBe(422);
    expect((await portal.catalog.get(entry.id))?.modelId).toBe("acme/quick-1");
  });
});
