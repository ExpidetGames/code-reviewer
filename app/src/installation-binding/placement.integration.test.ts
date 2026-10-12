// SPDX-License-Identifier: Apache-2.0

// Where an installation that nobody linked may go without a person binding it (docs/decisions/0001-editions-setup-
// and-accounts.md, section 2.9): nowhere in a multi-tenant instance, and in a single-tenant one only the
// installation of a private App on the App's own account. The webhook route and the synchronization (the one at
// start and the periodic one) are driven for real against the fake GitHub; what they may never do is make a
// connection from a delivery or from the App-wide list of installations.
import { describe, expect, it } from "vitest";
import { ownerIdFor } from "../../../fakes/github/registry.ts";
import {
  createBindingHarness,
  type BindingHarness,
} from "../test-support/binding-harness.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
/** The account the fake gives the App as its owner (`GET /app`). */
const OWN = {
  login: "fake-owner",
  id: ownerIdFor("fake-owner"),
  type: "User",
} as const;

async function nothingExists(h: BindingHarness) {
  expect(await h.integrationRows()).toEqual([]);
  expect(await h.repositoryRows()).toEqual([]);
}

describe("a multi-tenant instance", () => {
  // #103-IB-11
  it("makes no connection from an installation delivery, notes the installation as unclaimed and answers 2xx", async () => {
    const h = await createBindingHarness({ tenancy: "multi" });
    await h.workspace("a");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    const route = h.webhook();

    const answer = await route.deliver("installation.created");

    expect(answer).toEqual({ status: 202, outcome: "installation_unclaimed" });
    await nothingExists(h);
    expect(await h.unclaimed.list()).toEqual([
      expect.objectContaining({
        installationId: "4242",
        accountLogin: "acme",
        accountType: "Organization",
        source: "webhook",
      }),
    ]);
  });

  // #103-IB-11
  it("makes no connection from the installation list of the start-up sync or of a later one, and notes each as unclaimed", async () => {
    const h = await createBindingHarness({ tenancy: "multi" });
    await h.workspace("a");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    h.install(
      { id: 4300, account: { login: "octo", id: 1001, type: "User" } },
      ["octo/notes"],
    );

    const atStart = await h.sync.syncAll();
    const later = await h.sync.syncAll();

    expect(atStart.errors).toEqual([]);
    expect(later.errors).toEqual([]);
    expect(atStart.integrations.created).toBe(0);
    await nothingExists(h);
    expect(
      (await h.unclaimed.list()).map((entry) => entry.installationId),
    ).toEqual(["4242", "4300"]);
  });

  // #103-IB-11
  it("does nothing for the pull requests of an installation that is not linked", async () => {
    const h = await createBindingHarness({ tenancy: "multi" });
    await h.workspace("a");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    const route = h.webhook();

    const answer = await route.deliver("pull_request.opened");

    expect(answer).toEqual({ status: 202, outcome: "unknown_installation" });
    await nothingExists(h);
    expect(await h.unclaimed.list()).toEqual([]);
  });

  // #103-IB-11
  it("forgets an unclaimed installation that GitHub removed, and one that was linked", async () => {
    const h = await createBindingHarness({ tenancy: "multi" });
    const a = await h.workspace("a");
    const owner = await h.person("owner-a", {
      workspaceId: a.id,
      role: "owner",
    });
    h.githubUser(1001, "octo");
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    h.install({
      id: 4300,
      account: { login: "beta", id: 5100, type: "Organization" },
    });
    await h.sync.syncAll();
    expect(await h.unclaimed.list()).toHaveLength(2);

    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    h.github.removeInstallation(4300);
    await h.sync.syncAll();

    expect(await h.unclaimed.list()).toEqual([]);
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ external_id: "4242", workspace_id: a.id }),
    ]);
  });

  // #103-IB-11
  it("keeps the connections that exist, with their workspace, when it reads the installation list again", async () => {
    const h = await createBindingHarness({ tenancy: "multi" });
    const a = await h.workspace("a");
    const owner = await h.person("owner-a", {
      workspaceId: a.id,
      role: "owner",
    });
    h.githubUser(1001, "octo");
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    h.github.addRepository(4242, { id: 7002, fullName: "acme/gadgets" });

    const summary = await h.sync.syncAll();

    expect(summary.repositories.added).toBe(1);
    expect((await h.repositoryRows(a.id)).map((row) => row.full_name)).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
  });
});

describe("a single-tenant instance", () => {
  // #103-IB-12
  it.each(["webhook", "sync"] as const)(
    "attaches a new installation on the App's own account to the one workspace when the App is private (%s)",
    async (way) => {
      const h = await createBindingHarness({
        tenancy: "single",
        privateApp: true,
      });
      const only = await h.workspace("only");
      h.install({ id: 4242, account: OWN }, ["fake-owner/widgets"]);

      if (way === "webhook")
        expect(
          await h.webhook().deliver("installation.created", (payload) => {
            payload.installation = {
              ...(payload.installation as object),
              account: OWN,
            };
          }),
        ).toEqual({ status: 202, outcome: "installation_changed" });
      else await h.sync.syncAll();

      expect(await h.integrationRows()).toEqual([
        expect.objectContaining({ external_id: "4242", workspace_id: only.id }),
      ]);
      expect(
        (await h.repositoryRows(only.id)).map((row) => row.full_name),
      ).toEqual(["fake-owner/widgets"]);
      expect(await h.unclaimed.list()).toEqual([]);
    },
  );

  // #103-IB-12
  it.each(["webhook", "sync"] as const)(
    "does not attach an installation on another account, even of a private App (%s)",
    async (way) => {
      const h = await createBindingHarness({
        tenancy: "single",
        privateApp: true,
      });
      await h.workspace("only");
      h.install({ id: 4242, account: ACME }, ["acme/widgets"]);

      if (way === "webhook")
        expect(await h.webhook().deliver("installation.created")).toEqual({
          status: 202,
          outcome: "installation_unclaimed",
        });
      else await h.sync.syncAll();

      await nothingExists(h);
      expect(await h.unclaimed.list()).toHaveLength(1);
    },
  );

  // #103-IB-12
  it.each([false, null] as const)(
    "does not attach an installation on the App's own account when the App is not flagged private (%s)",
    async (flag) => {
      const h = await createBindingHarness({
        tenancy: "single",
        privateApp: flag,
      });
      await h.workspace("only");
      h.install({ id: 4242, account: OWN }, ["fake-owner/widgets"]);

      await h.sync.syncAll();
      const delivered = await h
        .webhook()
        .deliver("installation.created", (payload) => {
          payload.installation = {
            ...(payload.installation as object),
            account: OWN,
          };
        });

      expect(delivered).toEqual({
        status: 202,
        outcome: "installation_unclaimed",
      });
      await nothingExists(h);
      expect(await h.unclaimed.list()).toHaveLength(1);
    },
  );

  // #103-IB-12
  it("does not attach anything while the instance has no workspace or is not set up", async () => {
    const empty = await createBindingHarness({ tenancy: "single" });
    empty.install({ id: 4242, account: OWN }, ["fake-owner/widgets"]);
    await empty.sync.syncAll();
    await nothingExists(empty);

    const unset = await createBindingHarness({ tenancy: "single" });
    await unset.workspace("only");
    await unset.db
      .deleteFrom("instance_settings")
      .where("key", "=", "tenancy")
      .execute();
    unset.install({ id: 4242, account: OWN }, ["fake-owner/widgets"]);
    await unset.sync.syncAll();
    await nothingExists(unset);
  });

  // #103-IB-12
  it("reads the owner of the App from GitHub: an installation whose account id merely has the owner's name does not count", async () => {
    const h = await createBindingHarness({
      tenancy: "single",
      privateApp: true,
    });
    await h.workspace("only");
    h.install(
      { id: 4242, account: { login: "fake-owner", id: 999999, type: "User" } },
      ["fake-owner/widgets"],
    );

    await h.sync.syncAll();

    await nothingExists(h);
  });

  // #103-IB-12
  it("asks GitHub for the owner of the App once for all the new installations of one synchronization", async () => {
    const h = await createBindingHarness({
      tenancy: "single",
      privateApp: true,
    });
    await h.workspace("only");
    for (const id of [4242, 4243, 4244])
      h.install(
        {
          id,
          account: {
            login: `org-${String(id)}`,
            id: id + 1000,
            type: "Organization",
          },
        },
        [],
      );
    const appReads = () =>
      h.github.requests().filter((request) => request.path === "/app").length;

    await h.sync.syncAll();

    expect(await h.unclaimed.list()).toHaveLength(3);
    expect(appReads()).toBe(1);
    // Remembered only briefly: a later synchronization asks again.
    h.advance(60_000);
    h.install({ id: 4245, account: ACME }, []);
    await h.sync.syncAll();
    expect(appReads()).toBe(2);
  });

  // #103-IB-12
  it("needs the explicit Connect flow with the same checks for everything else", async () => {
    const h = await createBindingHarness({
      tenancy: "single",
      privateApp: true,
    });
    const only = await h.workspace("only");
    const owner = await h.person("owner", {
      workspaceId: only.id,
      role: "owner",
    });
    h.githubUser(1001, "octo");
    h.github.addOrgMember("acme", "octo", "active", "member");
    h.install({ id: 4242, account: ACME }, ["acme/widgets"]);
    await h.sync.syncAll();

    const run = await h.walk(owner, only.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "not_installation_admin" });
    await nothingExists(h);
  });
});
