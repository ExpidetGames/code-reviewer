// SPDX-License-Identifier: Apache-2.0

// #505: `GET` and `PUT /api/w/:workspace/billing/profile` as the app wires them (guard, same site, access, body, service), over a
// real database and the real matrix of roles. An Owner and an Admin keep the billing profile of the workspace (`manage_billing`);
// a Member gets 403 and sees and stores nothing; a refusal names a field and a code and never the value; the profile is never
// logged; billing off is the missing path.
import { describe, expect, it, vi } from "vitest";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { isBillingOn } from "./enabled.ts";
import { createProfileRoute } from "./profile-http.ts";
import { createBillingProfileService } from "./profile-service.ts";

const BASE_URL = "https://app.example.test";

class NotFound extends Error {}

const PROFILE = {
  legalName: "Acme GmbH",
  country: "DE",
  addressLine1: "Hauptstrasse 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
};

async function start(options: { billingOn?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const route = createProfileRoute({
    guard: {
      isOn: () => isBillingOn(db),
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    service: createBillingProfileService({ db }),
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (
      lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
      slug = "acme",
    ) =>
    (handler: Parameters<Parameters<typeof route.put>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug,
        action: "manage_billing",
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
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE_URL}/api/w/acme/billing/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = () => new Request(`${BASE_URL}/api/w/acme/billing/profile`);
  const stored = (workspace = workspaceId) =>
    createBillingProfilesRepository(db, workspace).get();
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    route,
    as,
    person,
    put,
    get,
    stored,
  };
}

describe("PUT /api/w/:workspace/billing/profile", () => {
  // #505-T03
  it("lets an Owner and an Admin save the profile and answers it back with no-store", async () => {
    const t = await start();

    const owner = await t.route.put(
      t.put(PROFILE),
      "acme",
      t.as(await t.person("owner")),
    );
    const admin = await t.route.put(
      t.put({ ...PROFILE, city: "Hamburg" }),
      "acme",
      t.as(await t.person("admin")),
    );

    expect(owner.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(admin.headers.get("cache-control")).toBe("no-store");
    expect(await admin.json()).toMatchObject({
      profile: {
        legalName: "Acme GmbH",
        city: "Hamburg",
        businessConfirmed: false,
      },
    });
    expect(await t.stored()).toMatchObject({
      city: "Hamburg",
      vatId: "DE123456789",
    });
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #505-T02
  it("answers a Member 403, stores nothing and gives nothing back", async () => {
    const t = await start();
    await createBillingProfilesRepository(t.db, t.workspaceId).save(PROFILE);
    const member = await t.person("member");

    const put = await t.route.put(
      t.put({ ...PROFILE, legalName: "Changed" }),
      "acme",
      t.as(member),
    );
    const get = await t.route.get(t.get(), "acme", t.as(member));

    expect(put.status).toBe(403);
    expect(get.status).toBe(403);
    expect(await put.json()).toEqual({ error: "forbidden" });
    expect(await get.text()).not.toContain("Acme");
    expect(await t.stored()).toMatchObject({ legalName: "Acme GmbH" });
  });

  // #505-T02
  it("answers a person of another workspace, and nobody signed in, with the refusals of every workspace route", async () => {
    const t = await start();
    const outsider = await t.person("owner", "u-outsider", t.otherWorkspaceId);

    const outside = await t.route.put(t.put(PROFILE), "acme", t.as(outsider));
    const anonymous = await t.route.put(
      t.put(PROFILE),
      "acme",
      t.as({ kind: "none" }),
    );

    expect(outside.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await t.stored()).toBeUndefined();
  });

  // #505-T03
  it("names the field and the code of a refusal and never echoes the value", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const response = await t.route.put(
      t.put({
        ...PROFILE,
        legalName: "",
        vatId: "DE12",
        postalCode: "SECRET-POSTAL\u0007",
      }),
      "acme",
      t.as(owner),
    );
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toEqual({
      error: "invalid_input",
      issues: expect.arrayContaining([
        { field: "legalName", code: "required" },
        { field: "vatId", code: "vat_id_invalid" },
        { field: "postalCode", code: "invalid_characters" },
      ]),
    });
    expect(text).not.toContain("SECRET-POSTAL");
    expect(text).not.toContain("DE12");
    expect(await t.stored()).toBeUndefined();
  });

  // #505-T03
  it("reads the profile back for an Owner, and null before one was saved", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const before = await t.route.get(t.get(), "acme", t.as(owner));
    await t.route.put(t.put(PROFILE), "acme", t.as(owner));
    const after = await t.route.get(t.get(), "acme", t.as(owner));

    expect(await before.json()).toEqual({ profile: null });
    expect(await after.json()).toMatchObject({
      profile: { vatId: "DE123456789" },
    });
  });

  // #505-T03
  it("logs nothing about the profile", async () => {
    const t = await start();
    const spies = [
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];

    await t.route.put(t.put(PROFILE), "acme", t.as(await t.person("owner")));

    for (const spy of spies)
      expect(JSON.stringify(spy.mock.calls)).not.toContain("Acme");
  });

  // #505-T03
  it("takes the workspace from the address, never from the body", async () => {
    const t = await start();

    await t.route.put(
      t.put({ ...PROFILE, workspaceId: t.otherWorkspaceId }),
      "acme",
      t.as(await t.person("owner")),
    );

    expect(await t.stored()).toBeDefined();
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #505-T03
  it("refuses a request from another site, a body that is not JSON and one that is too large", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const crossSite = await t.route.put(
      t.put(PROFILE, { "sec-fetch-site": "cross-site" }),
      "acme",
      t.as(owner),
    );
    const notJson = await t.route.put(
      new Request(`${BASE_URL}/api/w/acme/billing/profile`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      "acme",
      t.as(owner),
    );
    const tooLarge = await t.route.put(
      t.put({ ...PROFILE, padding: "x".repeat(20_000) }),
      "acme",
      t.as(owner),
    );

    expect([crossSite.status, notJson.status, tooLarge.status]).toEqual([
      403, 415, 413,
    ]);
    expect(await t.stored()).toBeUndefined();
  });

  // #505-T11
  it("is the missing path while billing is off, before anything else is asked", async () => {
    const t = await start({ billingOn: false });
    const withAccess = vi.fn(t.as(await t.person("owner")));

    await expect(
      t.route.put(t.put(PROFILE), "acme", withAccess),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      t.route.get(t.get(), "acme", withAccess),
    ).rejects.toBeInstanceOf(NotFound);
    expect(withAccess).not.toHaveBeenCalled();
  });
});
