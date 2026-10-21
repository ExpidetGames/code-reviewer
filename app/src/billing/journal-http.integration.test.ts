// SPDX-License-Identifier: Apache-2.0

// #505: `GET /api/w/:workspace/billing/journal` as the app wires it (guard, access, query, service), over a real database and the
// real matrix of roles. Every member reads the balance journal of their own workspace, page by page; nobody else does; billing
// off is the missing path.
import { describe, expect, it, vi } from "vitest";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createFakeBillingAdapter } from "../test-support/fake-billing-adapter.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { isBillingOn } from "./enabled.ts";
import { createJournalRoute } from "./journal-http.ts";
import { createWorkspaceBillingService } from "./workspace-page.ts";

const BASE_URL = "https://app.example.test";
const USD = 1_000_000;

class NotFound extends Error {}

async function start(options: { billingOn?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const route = createJournalRoute({
    guard: {
      isOn: () => isBillingOn(db),
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    service: createWorkspaceBillingService({
      db,
      activeAdapter: () => Promise.resolve(createFakeBillingAdapter()),
      keyMode: () => Promise.resolve("managed"),
    }),
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (
      lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
      slug = "acme",
    ) =>
    (handler: Parameters<Parameters<typeof route.get>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug,
        action: "view",
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = (
    role: WorkspaceRole,
    id = `u-${role}`,
    workspace = workspaceId,
  ) => signedInMember(db, { id, workspaceId: workspace, role });
  const get = (query = "") =>
    new Request(`${BASE_URL}/api/w/acme/billing/journal${query}`);
  return { db, workspaceId, otherWorkspaceId, route, as, person, get };
}

describe("GET /api/w/:workspace/billing/journal", () => {
  // #505-T02
  it("gives a Member the journal of their workspace page by page, with no-store", async () => {
    const t = await start();
    for (const amount of [1, 2, 3]) await fundWorkspace(t.db, t.workspaceId, amount * USD);

    const first = await t.route.get(
      t.get("?limit=2"),
      "acme",
      t.as(await t.person("member")),
    );

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = (await first.json()) as {
      rows: Array<{ amountMicroUsd: number }>;
      next: string | null;
    };
    expect(page.rows.map((row) => row.amountMicroUsd)).toEqual([3 * USD, 2 * USD]);
    expect(page.next).not.toBeNull();
    const second = await t.route.get(
      t.get(`?limit=2&cursor=${page.next}`),
      "acme",
      t.as(await t.person("member")),
    );
    expect(await second.json()).toEqual({
      rows: [expect.objectContaining({ amountMicroUsd: 1 * USD })],
      next: null,
    });
  });

  // #505-T02
  it("keeps another workspace's journal out, and answers its members and nobody signed in with the refusals of every workspace route", async () => {
    const t = await start();
    await fundWorkspace(t.db, t.workspaceId, 5 * USD);
    const outsider = await t.person("owner", "u-outsider", t.otherWorkspaceId);

    const outside = await t.route.get(t.get(), "acme", t.as(outsider));
    const anonymous = await t.route.get(t.get(), "acme", t.as({ kind: "none" }));

    expect(outside.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await outside.text()).not.toContain("5000000");
  });

  // #505-T02
  it.each(["cursor=abc", "cursor=0", "limit=0", "limit=51", "limit=x", "limit=1.5"])(
    "refuses the query %s with a stable code",
    async (query) => {
      const t = await start();

      const response = await t.route.get(
        t.get(`?${query}`),
        "acme",
        t.as(await t.person("member")),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "journal_query_invalid" });
    },
  );

  // #505-T11
  it("is the missing path while billing is off, before anything else is asked", async () => {
    const t = await start({ billingOn: false });
    const withAccess = vi.fn(t.as(await t.person("member")));

    await expect(t.route.get(t.get(), "acme", withAccess)).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(withAccess).not.toHaveBeenCalled();
  });
});
