// SPDX-License-Identifier: Apache-2.0

// Pins down the admin data route end to end over a real database and the real proxy: what it shows, what
// a change does and what it answers when a change is refused, that a request from another site is
// refused, and that a saved secret is nowhere in an answer or a log line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { ADMIN_REQUEST_MAX_BYTES } from "./http.ts";

const SECRET_VALUE = "super-secret-smtp-password-4d2f9a1b";

async function startPortal(options: { githubConfigured?: boolean } = {}) {
  return createAdminHarness(options);
}

function put(portal: AdminHarness, body: unknown, headers = {}) {
  return portal.visit("/api/admin/settings", {
    method: "PUT",
    body,
    cookies: portal.adminCookies,
    headers,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading the settings", () => {
  // #98-AD-12
  it("shows a saved secret as configured with the last four characters, and never the value", async () => {
    const portal = await startPortal();
    await portal.secrets.save("smtp_password", SECRET_VALUE, {
      updatedBy: portal.adminId,
    });
    await portal.secrets.save(
      "github_app_client_secret",
      "github-client-secret-0123456789-wxyz",
      { updatedBy: portal.adminId, showLastFour: true },
    );

    const response = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain("github-client-secret");
    const body = JSON.parse(text) as {
      secrets: Array<{ name: string; state: string; lastFour?: string | null }>;
    };
    expect(body.secrets).toContainEqual(
      expect.objectContaining({
        name: "smtp_password",
        state: "configured",
        lastFour: null,
      }),
    );
    expect(body.secrets).toContainEqual(
      expect.objectContaining({
        name: "github_app_client_secret",
        state: "configured",
        lastFour: "wxyz",
      }),
    );
  });

  // #98-AD-12
  it("writes the value of a secret into no log line, not even while the secret cannot be read", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const portal = await startPortal();
    await portal.secrets.save("smtp_password", SECRET_VALUE, {
      updatedBy: portal.adminId,
    });

    await portal.visit("/api/admin/settings", { cookies: portal.adminCookies });
    await portal.db.updateTable("secrets").set({ nonce: "AAAA" }).execute();
    const broken = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(broken.status).toBe(200);
    expect(await broken.text()).not.toContain(SECRET_VALUE);
    expect(lines.join("\n")).not.toContain(SECRET_VALUE);
  });

  // #98-AD-11
  it("answers with the error state of a secret that cannot be decrypted, not with a failure", async () => {
    const portal = await startPortal();
    await portal.secrets.save("smtp_password", SECRET_VALUE, {
      updatedBy: portal.adminId,
    });
    await portal.db
      .updateTable("secrets")
      .set({ ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
      .execute();

    const response = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      secrets: expect.arrayContaining([
        expect.objectContaining({
          name: "smtp_password",
          state: "undecryptable",
          code: "secret_undecryptable",
        }),
      ]),
    });
  });
});

describe("changing a setting", () => {
  // #98-AD-14
  it("stores the change with the admin and the time and shows both when the settings are read again", async () => {
    const portal = await startPortal();

    const response = await put(portal, {
      signUp: { kind: "domains", entries: ["Example.com"] },
    });
    const read = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(response.status).toBe(200);
    expect(await read.json()).toMatchObject({
      signUpRule: {
        value: { kind: "domains", entries: ["example.com"] },
        updatedBy: { id: portal.adminId, email: "admin@example.com" },
        updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
      },
    });
  });

  it("answers a successful change with the settings as they are now", async () => {
    const portal = await startPortal();

    const response = await put(portal, { limits: { maxWorkspacesPerUser: 4 } });

    expect(await response.json()).toMatchObject({
      ok: true,
      settings: { maxWorkspacesPerUser: { value: 4 } },
    });
  });

  // #202 (gate control)
  it("switches Dynamic Review on and off for the instance and shows who did it", async () => {
    const portal = await startPortal();
    const before = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    expect(await before.json()).toMatchObject({
      dynamicReview: { value: false, updatedBy: null },
    });

    const on = await put(portal, { dynamicReview: { enabled: true } });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      ok: true,
      settings: {
        dynamicReview: {
          value: true,
          updatedBy: { id: portal.adminId, email: "admin@example.com" },
        },
      },
    });

    const off = await put(portal, { dynamicReview: { enabled: false } });
    expect(await off.json()).toMatchObject({
      settings: { dynamicReview: { value: false } },
    });
  });

  // #202 (gate control)
  it("refuses a gate change that is not an object with a boolean", async () => {
    const portal = await startPortal();

    const response = await put(portal, { dynamicReview: { enabled: "yes" } });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "dynamicReview", code: "dynamic_review_invalid" }],
    });
    expect((await portal.service.readSettings()).dynamicReview.value).toBe(
      false,
    );
  });

  // #280-T01
  it("shows only whether each model tier is configured, never a model id, and has no way to change them", async () => {
    const portal = await startPortal();
    const read = async () =>
      await (
        await portal.visit("/api/admin/settings", {
          cookies: portal.adminCookies,
        })
      ).text();
    expect(JSON.parse(await read())).toMatchObject({
      modelTiers: {
        low: { diff: false, dynamic: false },
        medium: { diff: false, dynamic: false },
        high: { diff: false, dynamic: false },
      },
    });

    await createInstanceSettingsRepository(portal.db).set(
      "managed_model_tiers",
      {
        low: { diff: "secretco/portal-low" },
        high: { diff: "secretco/portal-high", dynamic: "secretco/portal-dyn" },
      },
      null,
    );

    const text = await read();
    expect(JSON.parse(text)).toMatchObject({
      modelTiers: {
        low: { diff: true, dynamic: false },
        medium: { diff: false, dynamic: false },
        high: { diff: true, dynamic: true },
      },
    });
    expect(text).not.toContain("secretco");
    // The portal cannot write them: the operator API is the only way.
    const refused = await put(portal, {
      modelTiers: { low: { diff: "secretco/other" } },
    });
    expect(refused.status).toBe(422);
    expect(
      await createInstanceSettingsRepository(portal.db).get(
        "managed_model_tiers",
      ),
    ).toMatchObject({ low: { diff: "secretco/portal-low" } });
  });

  // #284-T11
  it("shows the plan management page as unset, saves a valid https address and shows who did it", async () => {
    const portal = await startPortal();
    const before = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    expect(await before.json()).toMatchObject({
      planManagementUrl: { value: null, updatedBy: null },
    });

    const saved = await put(portal, {
      planManagementUrl: "https://plans.example",
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      settings: {
        planManagementUrl: {
          value: "https://plans.example/",
          updatedBy: { id: portal.adminId, email: "admin@example.com" },
        },
      },
    });
  });

  // #284-T11
  it.each([
    ["http:", "http://plans.example/", "url_not_https"],
    ["credentials", "https://user:pw@plans.example/", "url_has_credentials"],
    ["a fragment", "https://plans.example/#top", "url_has_fragment"],
    ["a relative address", "/plans", "url_invalid"],
    ["a number", 7, "url_invalid"],
  ])("refuses %s and keeps what was saved", async (_name, value, code) => {
    const portal = await startPortal();
    await put(portal, { planManagementUrl: "https://plans.example/" });

    const response = await put(portal, { planManagementUrl: value });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "planManagementUrl", code }],
    });
    expect((await portal.service.readSettings()).planManagementUrl.value).toBe(
      "https://plans.example/",
    );
  });

  // #284-T01
  it("removes the page with null, so there is no Manage plan again", async () => {
    const portal = await startPortal();
    await put(portal, { planManagementUrl: "https://plans.example/" });

    const response = await put(portal, { planManagementUrl: null });

    expect(response.status).toBe(200);
    expect(
      (await portal.service.readSettings()).planManagementUrl.value,
    ).toBeNull();
  });

  // #284-T07
  it("refuses a change from another site", async () => {
    const portal = await startPortal();

    const response = await put(
      portal,
      { planManagementUrl: "https://plans.example/" },
      { "sec-fetch-site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect(
      (await portal.service.readSettings()).planManagementUrl.value,
    ).toBeNull();
  });

  // #106-IM-07
  it("hides the notice of the import for good, and refuses a request that is not a dismissal", async () => {
    const portal = await startPortal();
    await createInstanceSettingsRepository(portal.db).set(
      "import_notice",
      {
        createdAt: "2026-10-12T08:00:00.000Z",
        dismissedAt: null,
        memberCount: 1,
        notMembers: [],
        notMembersTotal: 0,
        neverSignedIn: ["gina"],
        neverSignedInTotal: 1,
        organization: null,
        notImported: [],
        oauthApp: false,
        invalidLoginEntries: 0,
      },
      null,
    );
    const read = async () =>
      (await (
        await portal.visit("/api/admin/settings", {
          cookies: portal.adminCookies,
        })
      ).json()) as { importNotice: unknown };

    const before = await read();
    const refused = await put(portal, { importNotice: { dismiss: false } });
    const hidden = await put(portal, { importNotice: { dismiss: true } });
    const after = await read();

    expect(before.importNotice).toMatchObject({ neverSignedIn: ["gina"] });
    expect(refused.status).toBe(422);
    expect(hidden.status).toBe(200);
    expect(after.importNotice).toBeNull();
  });

  it("changes the tenancy and refuses the change to single-tenant with the number of workspaces", async () => {
    const portal = await startPortal();
    await put(portal, { tenancy: "multi" });
    for (const slug of ["a", "b"])
      await portal.db
        .insertInto("workspaces")
        .values({
          id: `w-${slug}`,
          name: slug,
          slug,
          created_by: null,
          created_at: "2026-10-11T00:00:00.000Z",
        })
        .execute();

    const response = await put(portal, { tenancy: "single" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "too_many_workspaces",
      count: 3,
    });
    expect((await portal.service.readSettings()).tenancy.value).toBe("multi");
  });

  // #98-AD-09
  it("refuses the sign-in methods that break the rules with the code", async () => {
    const portal = await startPortal({ githubConfigured: false });

    const both = await put(portal, {
      signInMethods: { emailPassword: false, github: false },
    });
    const github = await put(portal, {
      signInMethods: { emailPassword: true, github: true },
    });

    expect([both.status, await both.json()]).toEqual([
      422,
      { error: "at_least_one_method" },
    ]);
    expect([github.status, await github.json()]).toEqual([
      409,
      { error: "github_not_configured" },
    ]);
  });

  // #98-AD-16
  it("refuses GitHub only for an admin without a linked GitHub identity, and accepts it with one", async () => {
    const portal = await startPortal({ githubConfigured: true });
    const body = { signInMethods: { emailPassword: false, github: true } };

    const refused = await put(portal, body);
    await portal.db
      .updateTable("users")
      .set({ github_login: "octocat" })
      .where("id", "=", portal.adminId)
      .execute();
    await portal.db
      .insertInto("accounts")
      .values({
        id: "github-account",
        account_id: "583231",
        provider_id: "github",
        user_id: portal.adminId,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      })
      .execute();
    const accepted = await put(portal, body);

    expect([refused.status, await refused.json()]).toEqual([
      409,
      { error: "admin_needs_github_identity" },
    ]);
    expect(accepted.status).toBe(200);
  });

  it("names the fields of a setting that is not valid", async () => {
    const portal = await startPortal();

    const response = await put(portal, {
      signUp: { kind: "emails", entries: ["not an email"] },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "signUp.entries", code: "entry_invalid" }],
    });
  });

  it.each([
    ["nothing", {}],
    [
      "two settings at once",
      { tenancy: "multi", limits: { maxWorkspacesPerUser: 3 } },
    ],
    ["a setting that does not exist", { somethingElse: true }],
    ["an array", []],
    ["a string", "tenancy"],
    ["a tenancy that does not exist", { tenancy: "several" }],
    ["limits that are not an object", { limits: 5 }],
  ])("refuses a body with %s and changes nothing", async (_name, body) => {
    const portal = await startPortal();

    const response = await put(portal, body);

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe(
      "invalid_input",
    );
    expect((await portal.service.readSettings()).tenancy.value).toBe("single");
  });
});

describe("the requests the data route does not accept", () => {
  // #98-AD-13
  it.each([
    ["another site (Sec-Fetch-Site)", { "sec-fetch-site": "cross-site" }],
    ["a sibling subdomain (Sec-Fetch-Site)", { "sec-fetch-site": "same-site" }],
    ["another origin (no Sec-Fetch-Site)", { origin: "https://evil.example" }],
    ["an origin that is not an address", { origin: "null" }],
  ])("refuses a change that comes from %s", async (_name, headers) => {
    const portal = await startPortal();

    const response = await put(portal, { tenancy: "multi" }, headers);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
    expect((await portal.service.readSettings()).tenancy.value).toBe("single");
  });

  // #98-AD-13
  it("accepts a change from the same origin", async () => {
    const portal = await startPortal();

    const response = await put(
      portal,
      { tenancy: "multi" },
      { "sec-fetch-site": "same-origin" },
    );

    expect(response.status).toBe(200);
  });

  it("refuses a body that is not JSON", async () => {
    const portal = await startPortal();

    const response = await portal.visit("/api/admin/settings", {
      method: "PUT",
      body: "tenancy=multi",
      cookies: portal.adminCookies,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "unsupported_content_type",
    });
    expect((await portal.service.readSettings()).tenancy.value).toBe("single");
  });

  it("refuses a body that is far larger than any setting", async () => {
    const portal = await startPortal();

    const response = await put(portal, {
      signUp: {
        kind: "emails",
        entries: ["x".repeat(ADMIN_REQUEST_MAX_BYTES)],
      },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "body_too_large" });
  });

  it("answers every refusal with no-store", async () => {
    const portal = await startPortal();

    const answers = await Promise.all([
      put(portal, { tenancy: "x" }),
      put(portal, { tenancy: "multi" }, { "sec-fetch-site": "cross-site" }),
    ]);

    for (const answer of answers)
      expect(answer.headers.get("cache-control")).toBe("no-store");
  });
});
