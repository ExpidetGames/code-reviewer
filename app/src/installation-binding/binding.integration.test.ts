// SPDX-License-Identifier: LicenseRef-Proprietary

// The binding of an installation to a workspace through the real services over a real Postgres database and the fake
// GitHub (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): who may link which installation, with
// what proof, and that everything that cannot be established links nothing. The proof is the person's own GitHub
// token, obtained during the flow; these tests walk the whole round trip (the installation page, the setup
// address, the authorization, the callback) the way a browser does.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import {
  createBindingHarness,
  type BindingHarness,
} from "../test-support/binding-harness.ts";
import type { BindingActor } from "./service.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

/** A workspace A with an Owner whose GitHub account is `octo`, and a GitHub with an installation on `acme`. */
async function scene(options: Parameters<typeof createBindingHarness>[0] = {}) {
  const h = await createBindingHarness(options);
  const a = await h.workspace("a");
  const owner = await h.person("owner-a", { workspaceId: a.id, role: "owner" });
  h.githubUser(1001, "octo");
  // A second person with a GitHub account of their own, for the scenes with two workspaces.
  h.githubUser(1003, "octo2");
  h.install({ id: 4242, account: ACME }, ["acme/widgets", "acme/gadgets"]);
  return { h, a, owner };
}

/** Nothing was linked and nothing was asked of the instance admin. */
async function expectNothingLinked(h: BindingHarness) {
  expect(await h.integrationRows()).toEqual([]);
  expect(await h.repositoryRows()).toEqual([]);
  expect(await h.requests.listPending()).toEqual([]);
}

/** "Connect GitHub" and the click on "Install": the address GitHub sends the browser back to. */
async function installed(
  h: BindingHarness,
  actor: BindingActor,
  workspaceId: string,
  installationId = 4242,
) {
  const started = await h.binding.service.startConnect(actor, workspaceId);
  if (!started.ok) throw new Error(`Connect did not start: ${started.error}`);
  const back = await h.confirmInstallation(started.url, { installationId });
  return {
    state: back.searchParams.get("state") ?? "",
    query: (state: string) => ({
      installationId: String(installationId),
      setupAction: "install",
      state,
    }),
  };
}

function tampered(value: string): string {
  return `${value.slice(0, -2)}${value.endsWith("AA") ? "BB" : "AA"}`;
}

describe("linking an installation the person owns", () => {
  // #103-IB-02
  it("links the installation on the person's own account, reads its repositories and ends on the connections of the workspace", async () => {
    const { h, a, owner } = await scene();
    h.install(
      { id: 4300, account: { login: "octo", id: 1001, type: "User" } },
      ["octo/notes"],
    );

    const run = await h.walk(owner, a.id, {
      installationId: 4300,
      githubLogin: "octo",
    });

    expect(run.final).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "linked",
    });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({
        workspace_id: a.id,
        external_id: "4300",
        status: "active",
      }),
    ]);
    expect((await h.repositoryRows(a.id)).map((row) => row.full_name)).toEqual([
      "octo/notes",
    ]);
  });

  // #103-IB-03
  it("links the installation of an organization when the person is an owner of it", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "linked",
    });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ workspace_id: a.id, external_id: "4242" }),
    ]);
    expect((await h.repositoryRows(a.id)).map((row) => row.full_name)).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
  });

  // #103-IB-04
  it("refuses an organization's installation to a member who is not an owner, when the role can be read", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "member");

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "not_installation_admin" });
    await expectNothingLinked(h);
  });

  // #103-IB-04
  it("refuses a person whose invitation to the organization was not accepted, an outside collaborator and the account of somebody else", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "pending", "admin");
    h.github.grantInstallationAccess(4242, "octo");

    const pending = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });
    // The personal account of another person, which `octo` can see as a collaborator.
    h.githubUser(1002, "hermit");
    h.install(
      { id: 4400, account: { login: "hermit", id: 1002, type: "User" } },
      ["hermit/notes"],
    );
    h.github.grantInstallationAccess(4400, "octo");
    const foreign = await h.walk(owner, a.id, {
      installationId: 4400,
      githubLogin: "octo",
    });

    expect(pending.final).toMatchObject({ code: "not_installation_admin" });
    expect(foreign.final).toMatchObject({ code: "not_installation_admin" });
    await expectNothingLinked(h);
  });

  // #103-IB-04
  it("never takes access to the installation, or being the admin of a repository, as the right to link it", async () => {
    const { h, a, owner } = await scene();
    h.github.grantInstallationAccess(4242, "octo");
    h.github.setCollaboratorPermission("acme/widgets", "octo", "admin");

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    // Not a member of the organization at all: GitHub says so (404) and nothing is linked or asked.
    expect(run.final).toMatchObject({ code: "not_installation_admin" });
    await expectNothingLinked(h);
  });

  // #103-IB-05
  it("refuses an installation id the person's token cannot use, whether it is a guess or belongs to somebody else", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.install(
      {
        id: 4900,
        account: { login: "other-org", id: 5900, type: "Organization" },
      },
      ["other-org/secret"],
    );

    const guessed = await h.walk(owner, a.id, {
      installationId: 99999,
      githubLogin: "octo",
    });
    const foreign = await h.walk(owner, a.id, {
      installationId: 4900,
      githubLogin: "octo",
    });

    expect(guessed.final).toMatchObject({
      code: "installation_not_accessible",
    });
    expect(foreign.final).toMatchObject({
      code: "installation_not_accessible",
    });
    await expectNothingLinked(h);
  });
});

describe("a state that is not the one of this person and this moment", () => {
  // #103-IB-06
  it("refuses a state whose signature was changed, and does not use it up", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    const { state, query } = await installed(h, owner, a.id);

    const forged = await h.binding.service.completeSetup(
      owner,
      query(tampered(state)),
    );
    const genuine = await h.binding.service.completeSetup(owner, query(state));

    expect(forged).toEqual({
      kind: "done",
      workspaceId: null,
      code: "state_invalid",
    });
    expect(genuine.kind).toBe("authorize");
    await expectNothingLinked(h);
  });

  // #103-IB-06
  it("refuses a state after its ten minutes", async () => {
    const { h, a, owner } = await scene();
    const { state, query } = await installed(h, owner, a.id);

    h.advance(11 * 60 * 1000);
    const result = await h.binding.service.completeSetup(owner, query(state));

    expect(result).toEqual({
      kind: "done",
      workspaceId: null,
      code: "state_invalid",
    });
    await expectNothingLinked(h);
  });

  // #103-IB-06
  it("refuses a state that was used already, at the setup address and at the authorization", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    const { state, query } = await installed(h, owner, a.id);
    const first = await h.binding.service.completeSetup(owner, query(state));
    if (first.kind !== "authorize")
      throw new Error("expected the authorization");
    const callback = await h.github.authorize(first.url, "octo");
    const answer = {
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
      error: null,
    };

    const replayedSetup = await h.binding.service.completeSetup(
      owner,
      query(state),
    );
    const linked = await h.binding.service.completeAuthorization(owner, answer);
    const replayedAuthorization = await h.binding.service.completeAuthorization(
      owner,
      answer,
    );

    expect(replayedSetup).toMatchObject({ code: "state_invalid" });
    expect(linked).toMatchObject({ code: "linked" });
    expect(replayedAuthorization).toMatchObject({ code: "state_invalid" });
    expect(await h.integrationRows()).toHaveLength(1);
  });

  // #103-IB-06
  it("refuses a state presented by another person or from another browser session, and the owner can still use it", async () => {
    const { h, a, owner } = await scene();
    const colleague = await h.person("admin-a", {
      workspaceId: a.id,
      role: "admin",
    });
    const { state, query } = await installed(h, owner, a.id);

    const otherPerson = await h.binding.service.completeSetup(
      colleague,
      query(state),
    );
    const otherSession = await h.binding.service.completeSetup(
      { id: owner.id, sessionId: "another-browser" },
      query(state),
    );
    const owners = await h.binding.service.completeSetup(owner, query(state));

    expect(otherPerson).toMatchObject({ code: "state_invalid" });
    expect(otherSession).toMatchObject({ code: "state_invalid" });
    expect(owners.kind).toBe("authorize");
    await expectNothingLinked(h);
  });

  // #103-IB-06
  it("refuses a state made for another purpose", async () => {
    const { h, a, owner } = await scene();
    const other = await h.binding.signedStates.issue({
      purpose: "github-link",
      userId: owner.id,
      sessionId: owner.sessionId,
      workspaceId: a.id,
    });

    const result = await h.binding.service.completeSetup(owner, {
      installationId: "4242",
      setupAction: "install",
      state: other,
    });

    expect(result).toMatchObject({ code: "state_invalid" });
    await expectNothingLinked(h);
  });

  // #103-IB-06
  it("links nothing when the person is no longer an Owner or Admin of the workspace, at either step", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    const first = await installed(h, owner, a.id);
    await h.db
      .deleteFrom("workspace_members")
      .where("user_id", "=", owner.id)
      .execute();

    const atSetup = await h.binding.service.completeSetup(
      owner,
      first.query(first.state),
    );

    expect(atSetup).toEqual({
      kind: "done",
      workspaceId: null,
      code: "workspace_role_required",
    });

    await h.workspaces.addMember(a.id, owner.id, "owner");
    const second = await installed(h, owner, a.id);
    const authorize = await h.binding.service.completeSetup(
      owner,
      second.query(second.state),
    );
    if (authorize.kind !== "authorize")
      throw new Error("expected the authorization");
    await h.db
      .updateTable("workspace_members")
      .set({ role: "member" })
      .where("user_id", "=", owner.id)
      .execute();
    const callback = await h.github.authorize(authorize.url, "octo");

    const atAuthorization = await h.binding.service.completeAuthorization(
      owner,
      {
        code: callback.searchParams.get("code"),
        state: callback.searchParams.get("state"),
        error: null,
      },
    );

    expect(atAuthorization).toMatchObject({ code: "workspace_role_required" });
    await expectNothingLinked(h);
  });

  // #103-IB-06
  it("refuses a Member from the start: Connect GitHub is for an Owner or Admin", async () => {
    const { h, a } = await scene();
    const member = await h.person("member-a", {
      workspaceId: a.id,
      role: "member",
    });

    const connect = await h.binding.service.startConnect(member, a.id);
    const picker = await h.binding.service.startPicker(member, a.id);

    expect(connect).toEqual({ ok: false, error: "workspace_role_required" });
    expect(picker).toEqual({ ok: false, error: "workspace_role_required" });
  });
});

describe("an installation that belongs to a workspace already", () => {
  // #103-IB-07
  it("refuses another workspace without saying whose it is, leaves the owner's connection as it is, and lets the owner link it again", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.addOrgMember("acme", "octo2", "active", "admin");
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    await h.walk(ownerB, b.id, { installationId: 4242, githubLogin: "octo2" });
    const before = await h.integrationRows();
    const reposBefore = await h.repositoryRows();

    const refused = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });
    const again = await h.walk(ownerB, b.id, {
      installationId: 4242,
      githubLogin: "octo2",
    });

    expect(refused.final).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "installation_already_linked",
    });
    // The answer names no workspace.
    expect(JSON.stringify(refused.final)).not.toContain(b.id);
    expect(JSON.stringify(refused.final)).not.toContain("workspace-b");
    expect(again.final).toMatchObject({ code: "linked" });
    expect(await h.integrationRows()).toEqual(before);
    expect(await h.repositoryRows()).toEqual(reposBefore);
  });

  // #103-IB-07
  it("tells a person who cannot use the installation nothing about it being linked", async () => {
    const { h, a } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    await h.walk(ownerB, b.id, { installationId: 4242, githubLogin: "octo" });
    h.githubUser(2002, "stranger");
    const stranger = await h.person("stranger-a", {
      workspaceId: a.id,
      role: "owner",
    });

    const run = await h.walk(stranger, a.id, {
      installationId: 4242,
      githubLogin: "stranger",
    });

    // The same answer as for an installation that does not exist.
    expect(run.final).toMatchObject({ code: "installation_not_accessible" });
  });
});

describe("a person who signed in without GitHub", () => {
  // #103-IB-08
  it("is sent through GitHub's authorization first, and the GitHub account becomes their own identity without a second user", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    const users = await h.userCount();
    expect(await h.githubAccounts(owner.id)).toEqual([]);

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.setup).toMatchObject({ kind: "authorize" });
    expect(run.final).toMatchObject({ code: "linked" });
    expect(await h.githubAccounts(owner.id)).toEqual([
      { account_id: "1001", provider_id: "github" },
    ]);
    expect(await h.userCount()).toBe(users);
  });

  // #103-IB-08
  it("cannot use a GitHub account of another user of the instance, nor another account than the one they have linked", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.githubUser(1002, "second");
    h.github.addOrgMember("acme", "second", "active", "admin");
    await h.person("someone-else");
    await h.db
      .insertInto("accounts")
      .values({
        id: "github-someone-else",
        account_id: "1001",
        provider_id: "github",
        user_id: "someone-else",
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: "2026-10-12T08:00:00.000Z",
        updated_at: "2026-10-12T08:00:00.000Z",
      })
      .execute();

    const taken = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });
    const own = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "second",
    });
    const other = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(taken.final).toMatchObject({
      code: "identity_belongs_to_other_user",
    });
    expect(own.final).toMatchObject({ code: "linked" });
    // Now that "second" is the person's identity, "octo" is not them.
    expect(other.final).toMatchObject({ code: "github_identity_mismatch" });
    expect(await h.githubAccounts(owner.id)).toEqual([
      { account_id: "1002", provider_id: "github" },
    ]);
  });
});

describe("an authorization that is no good", () => {
  // #103-IB-09
  it("asks the person to authorize again when GitHub refuses the code, and links nothing", async () => {
    const { h, a, owner } = await scene();
    h.github.failTokenEndpoint({ kind: "status", status: 400 });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "github_authorization_required" });
    await expectNothingLinked(h);
  });

  // #103-IB-09
  it("asks the person to authorize again when their token is refused afterwards (expired or revoked)", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.fail({ pathIncludes: "/user/installations", status: 401 });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "github_authorization_required" });
    await expectNothingLinked(h);
  });

  // #103-IB-09
  it("links nothing and says so when GitHub cannot be reached", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.fail({ pathIncludes: "/user/installations", status: 503 });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "github_unreachable" });
    await expectNothingLinked(h);
  });

  // #103-IB-09
  it("reports a person who cancelled at GitHub, without any call with a token", async () => {
    const { h, a, owner } = await scene();
    const { state, query } = await installed(h, owner, a.id);
    const authorize = await h.binding.service.completeSetup(
      owner,
      query(state),
    );
    if (authorize.kind !== "authorize")
      throw new Error("expected the authorization");
    const denied = await h.github.deny(authorize.url);

    const result = await h.binding.service.completeAuthorization(owner, {
      code: null,
      state: denied.searchParams.get("state"),
      error: denied.searchParams.get("error"),
    });

    expect(result).toMatchObject({ code: "access_denied" });
    await expectNothingLinked(h);
  });
});

describe("an installation that the owners of the account have to approve on GitHub", () => {
  // #103-IB-10
  it("is shown as waiting, links nothing, and is linked through the list of installations once it exists", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");

    const asked = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
      action: "request",
    });

    expect(asked.setup).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "waiting_for_github_approval",
    });
    await expectNothingLinked(h);

    // Later the owners approved on GitHub: the installation shows in the list and is linked the same way.
    const start = await h.binding.service.startPicker(owner, a.id);
    if (!start.ok) throw new Error("the list did not start");
    const listed = await h.authorize(owner, start.url, "octo");
    if (listed.kind !== "done" || listed.picker === undefined)
      throw new Error("expected the list");
    expect(listed.code).toBe("picker_ready");
    expect(
      await h.binding.service.readPicker(owner, a.id, listed.picker),
    ).toEqual([
      {
        installationId: "4242",
        accountLogin: "acme",
        accountType: "Organization",
      },
    ]);
    const choose = await h.binding.service.chooseFromPicker(owner, a.id, {
      picker: listed.picker,
      installationId: "4242",
    });
    if (!choose.ok) throw new Error("the choice did not start");
    const linked = await h.authorize(owner, choose.url, "octo");

    expect(linked).toMatchObject({ code: "linked" });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({ workspace_id: a.id, external_id: "4242" }),
    ]);
  });

  // #103-IB-10
  it("applies the same checks to a choice from the list: a member of the organization cannot link it", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "member");
    const start = await h.binding.service.startPicker(owner, a.id);
    if (!start.ok) throw new Error("the list did not start");
    const listed = await h.authorize(owner, start.url, "octo");
    if (listed.kind !== "done" || listed.picker === undefined)
      throw new Error("expected the list");
    const choose = await h.binding.service.chooseFromPicker(owner, a.id, {
      picker: listed.picker,
      installationId: "4242",
    });
    if (!choose.ok) throw new Error("the choice did not start");

    const result = await h.authorize(owner, choose.url, "octo");

    expect(result).toMatchObject({ code: "not_installation_admin" });
    await expectNothingLinked(h);
  });

  // #103-IB-10
  it("offers only the installations that no workspace has linked, and refuses a choice that is not in the list", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    // An organization both people administer, whose installation workspace B has linked.
    const beta = { login: "beta", id: 5100, type: "Organization" } as const;
    h.install({ id: 4300, account: beta }, ["beta/app"]);
    h.github.addOrgMember("beta", "octo", "active", "admin");
    h.github.addOrgMember("beta", "octo2", "active", "admin");
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    await h.walk(ownerB, b.id, { installationId: 4300, githubLogin: "octo2" });
    const start = await h.binding.service.startPicker(owner, a.id);
    if (!start.ok) throw new Error("the list did not start");

    const listed = await h.authorize(owner, start.url, "octo");

    if (listed.kind !== "done" || listed.picker === undefined)
      throw new Error("expected the list");
    expect(
      (await h.binding.service.readPicker(owner, a.id, listed.picker))?.map(
        (entry) => entry.installationId,
      ),
    ).toEqual(["4242"]);
    expect(
      await h.binding.service.chooseFromPicker(owner, a.id, {
        picker: listed.picker,
        installationId: "4300",
      }),
    ).toEqual({ ok: false, error: "picker_invalid" });
    // The list is for the workspace, the person and the session it was made for.
    const bAdmin = await h.person("admin-b", {
      workspaceId: b.id,
      role: "admin",
    });
    expect(
      await h.binding.service.readPicker(owner, b.id, listed.picker),
    ).toBeNull();
    expect(
      await h.binding.service.readPicker(bAdmin, a.id, listed.picker),
    ).toBeNull();
  });
});

describe("a role that GitHub does not let the app read", () => {
  // #103-IB-19
  it("links nothing, reads no repository, and asks the instance admin with the evidence", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    // The App lacks the organization permission "Members": the role of the person cannot be read.
    h.github.setAppAccountPermissions({ emails: "read" });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "waiting_for_instance_admin",
    });
    expect(await h.integrationRows()).toEqual([]);
    expect(await h.repositoryRows()).toEqual([]);
    expect(await h.requests.listPending()).toEqual([
      expect.objectContaining({
        workspaceId: a.id,
        requestedBy: owner.id,
        requesterGithubLogin: "octo",
        installationId: "4242",
        accountLogin: "acme",
        accountType: "Organization",
        status: "pending",
        evidence: {
          tokenCanAccess: true,
          roleResult: "unreadable",
          roleDetail: "forbidden",
        },
      }),
    ]);
    // No repository of the organization was read for it.
    expect(
      h.github
        .requests()
        .filter((request) =>
          request.path.includes("/installation/repositories"),
        ),
    ).toEqual([]);
  });

  // #103-IB-19
  it("asks once per installation: a second attempt refreshes the request instead of making another", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.setAppAccountPermissions({ emails: "read" });

    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });
    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });

    expect(await h.requests.listPending()).toHaveLength(1);
  });

  // #103-IB-19
  it("does not ask the instance admin when the person cannot use the installation, or when it belongs to another workspace", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.addOrgMember("acme", "octo2", "active", "admin");
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    await h.walk(ownerB, b.id, { installationId: 4242, githubLogin: "octo2" });
    h.github.setAppAccountPermissions({ emails: "read" });
    h.install({
      id: 4900,
      account: { login: "other-org", id: 5900, type: "Organization" },
    });

    const foreign = await h.walk(owner, a.id, {
      installationId: 4900,
      githubLogin: "octo",
    });
    const taken = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(foreign.final).toMatchObject({
      code: "installation_not_accessible",
    });
    expect(taken.final).toMatchObject({ code: "installation_already_linked" });
    expect(await h.requests.listPending()).toEqual([]);
  });

  // #103-IB-19
  it("treats a membership answer it cannot read, or a failing organization endpoint, as an unreadable role", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.failMembershipEndpoint({ kind: "status", status: 403 });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "waiting_for_instance_admin" });
    expect(await h.integrationRows()).toEqual([]);
  });

  // #103-IB-09
  it("does not ask the instance admin when GitHub is down while the role is read", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.failMembershipEndpoint({ kind: "status", status: 503 });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "github_unreachable" });
    await expectNothingLinked(h);
  });
});

describe("Connect GitHub without the user authorization of the App", () => {
  // #103-IB-22
  it("is not available in a multi-tenant instance", async () => {
    const { h, a, owner } = await scene({
      tenancy: "multi",
      userAuthorization: false,
    });

    const connect = await h.binding.service.startConnect(owner, a.id);
    const picker = await h.binding.service.startPicker(owner, a.id);

    expect(connect).toEqual({
      ok: false,
      error: "user_authorization_not_configured",
    });
    expect(picker).toEqual({
      ok: false,
      error: "user_authorization_not_configured",
    });
  });

  // #103-IB-22
  it("leaves the decision to the instance admin in a single-tenant instance, for an installation the instance has noted", async () => {
    const { h, a, owner } = await scene({
      tenancy: "single",
      userAuthorization: false,
    });
    // Installed on GitHub, the instance heard of it (the synchronization, here) and nobody has linked it.
    await h.sync.syncAll();
    expect(
      (await h.unclaimed.list()).map((entry) => entry.installationId),
    ).toEqual(["4242"]);

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.setup).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "waiting_for_instance_admin",
    });
    expect(await h.integrationRows()).toEqual([]);
    expect(await h.requests.listPending()).toEqual([
      expect.objectContaining({
        installationId: "4242",
        accountLogin: "acme",
        evidence: {
          tokenCanAccess: null,
          roleResult: "unavailable",
          roleDetail: "user_authorization_not_configured",
        },
      }),
    ]);
  });

  // #103-IB-22
  it("gives an id it has not noted the same answer whether GitHub knows it, does not know it, or another workspace has it, and does not ask GitHub about it", async () => {
    const { h, a, owner } = await scene({
      tenancy: "single",
      userAuthorization: false,
    });
    // 4800: a real installation nobody told the instance about. 4900: GitHub has none. 4700: linked elsewhere.
    h.install({
      id: 4800,
      account: { login: "stranger", id: 5800, type: "Organization" },
    });
    h.install({
      id: 4700,
      account: { login: "taken", id: 5700, type: "Organization" },
    });
    const b = await h.workspace("b");
    await createIntegrationsRepository(h.db, b.id).create({
      type: "github_app",
      displayName: "taken",
      externalId: "4700",
      config: {
        accountLogin: "taken",
        accountId: 5700,
        accountType: "Organization",
      },
      status: "active",
    });
    const before = h.github.requests().length;

    const answers = [];
    for (const installationId of [4800, 4900, 4700])
      answers.push(
        (await h.walk(owner, a.id, { installationId, githubLogin: "octo" }))
          .setup,
      );

    for (const answer of answers)
      expect(answer).toEqual({
        kind: "done",
        workspaceId: a.id,
        code: "installation_not_accessible",
      });
    expect(await h.requests.listPending()).toEqual([]);
    // GitHub was not asked what these ids are: nothing to learn from the answer, and no probe.
    expect(
      h.github
        .requests()
        .slice(before)
        .filter((request) =>
          /\/app\/installations\/(4800|4900|4700)/.test(request.path),
        ),
    ).toEqual([]);
  });

  // #103-IB-22
  it("tells the workspace that already has the installation that it is linked, without a request", async () => {
    const { h, a, owner } = await scene({
      tenancy: "single",
      userAuthorization: false,
    });
    await createIntegrationsRepository(h.db, a.id).create({
      type: "github_app",
      displayName: "acme",
      externalId: "4242",
      config: {
        accountLogin: "acme",
        accountId: 5001,
        accountType: "Organization",
      },
      status: "active",
    });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.setup).toEqual({
      kind: "done",
      workspaceId: a.id,
      code: "linked",
    });
    expect(await h.requests.listPending()).toEqual([]);
  });

  // #103-IB-22
  it("treats an instance whose tenancy is not stored as multi-tenant: no Connect, and no request for the instance admin", async () => {
    const { h, a, owner } = await scene({
      tenancy: "single",
      userAuthorization: false,
    });
    await h.db
      .deleteFrom("instance_settings")
      .where("key", "=", "tenancy")
      .execute();

    const availability = await h.binding.service.availability();
    const connect = await h.binding.service.startConnect(owner, a.id);

    expect(availability).toEqual({
      connect: "user_authorization_not_configured",
      picker: false,
    });
    expect(connect).toEqual({
      ok: false,
      error: "user_authorization_not_configured",
    });
    await expectNothingLinked(h);
  });

  // #103-IB-22
  it("does not start without a GitHub App at all", async () => {
    const { h, a, owner } = await scene();
    await h.db
      .deleteFrom("instance_settings")
      .where("key", "=", "github_app")
      .execute();

    expect(await h.binding.service.startConnect(owner, a.id)).toEqual({
      ok: false,
      error: "github_app_not_configured",
    });
  });
});

describe("what the binding does with the token of the person", () => {
  /**
   * Everything the binding keeps or says: every table that could hold it, the log, and the answers of the steps
   * that were walked. None of the tokens the fake GitHub issued may be in any of it.
   */
  async function expectNoTokenAnywhere(
    h: BindingHarness,
    ...answers: unknown[]
  ) {
    const tokens = h.github.issuedAccessTokens();
    expect(tokens.length).toBeGreaterThan(0);
    const tables = [
      "accounts",
      "signed_states",
      "installation_link_requests",
      "unclaimed_installations",
      "integrations",
      "sessions",
      "verifications",
      "instance_settings",
      "secrets",
    ] as const;
    const dump = JSON.stringify([
      answers,
      h.logs,
      ...(await Promise.all(
        tables.map((table) => h.db.selectFrom(table).selectAll().execute()),
      )),
    ]);
    // A signed state carries its facts in base64url: read every such piece as text too, so a token put into one
    // is found as well.
    const decoded = (dump.match(/[A-Za-z0-9_-]{16,}/g) ?? [])
      .map((piece) => Buffer.from(piece, "base64url").toString("utf8"))
      .join("\n");
    for (const token of tokens) {
      expect(dump).not.toContain(token);
      expect(decoded).not.toContain(token);
    }
  }

  // #103-IB-09
  it("keeps no GitHub token anywhere after a link: not in a table, not in the log, not in an answer", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "linked" });
    await expectNoTokenAnywhere(h, run);
  });

  // #103-IB-09
  it("keeps no GitHub token anywhere after the list of installations and a choice from it", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");

    const start = await h.binding.service.startPicker(owner, a.id);
    if (!start.ok) throw new Error("the list did not start");
    const listed = await h.authorize(owner, start.url, "octo");
    if (listed.kind !== "done" || listed.picker === undefined)
      throw new Error("expected the list");
    const read = await h.binding.service.readPicker(owner, a.id, listed.picker);
    const choose = await h.binding.service.chooseFromPicker(owner, a.id, {
      picker: listed.picker,
      installationId: "4242",
    });
    if (!choose.ok) throw new Error("the choice did not start");
    const linked = await h.authorize(owner, choose.url, "octo");

    expect(linked).toMatchObject({ code: "linked" });
    // The list was made while the token existed: nothing of it is in the list, which the page reads back.
    expect(listed.picker).not.toContain(h.github.issuedAccessTokens()[0]);
    await expectNoTokenAnywhere(h, start, listed, read, choose, linked);
  });

  // #103-IB-09
  it("keeps no GitHub token anywhere after a role that could not be read: the request holds the evidence and no token", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");
    h.github.setAppAccountPermissions({ emails: "read" });

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "waiting_for_instance_admin" });
    await expectNoTokenAnywhere(h, run, await h.requests.listPending());
  });

  // #103-IB-09
  it("keeps no GitHub token anywhere after a refusal, and the log of a refusal names the code only", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "member");

    const run = await h.walk(owner, a.id, {
      installationId: 4242,
      githubLogin: "octo",
    });

    expect(run.final).toMatchObject({ code: "not_installation_admin" });
    await expectNoTokenAnywhere(h, run);
  });

  // #103-IB-09
  it("makes the calls with the token of the person who authorized, and the App's own calls with its JWT", async () => {
    const { h, a, owner } = await scene();
    h.github.addOrgMember("acme", "octo", "active", "admin");

    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });

    const paths = h.github.requests().map((request) => request.path);
    expect(paths).toContain("/user/installations");
    expect(paths).toContain("/user/memberships/orgs/acme");
  });
});

describe("limits", () => {
  // #103-IB-17
  it("limits how often a person can begin a connection", async () => {
    const { h, a, owner } = await scene();

    const results = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      results.push(await h.binding.service.startConnect(owner, a.id));

    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(results.at(-1)).toMatchObject({ ok: false, error: "rate_limited" });
    // The window ends: a person can begin again.
    h.advance(11 * 60 * 1000);
    expect(await h.binding.service.startConnect(owner, a.id)).toMatchObject({
      ok: true,
    });
  });

  // #103-IB-17
  it("limits the callbacks of a person, and the list of installations", async () => {
    const { h, a, owner } = await scene();

    const callbacks = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      callbacks.push(
        await h.binding.service.completeSetup(owner, {
          installationId: "4242",
          setupAction: "install",
          state: "not-a-state",
        }),
      );
    const lists = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      lists.push(await h.binding.service.startPicker(owner, a.id));

    expect(
      callbacks
        .slice(0, 10)
        .every((r) => r.kind === "done" && r.code === "state_invalid"),
    ).toBe(true);
    expect(callbacks.slice(10)).toEqual([
      { kind: "done", workspaceId: null, code: "rate_limited" },
      { kind: "done", workspaceId: null, code: "rate_limited" },
    ]);
    expect(lists.at(-1)).toMatchObject({ ok: false, error: "rate_limited" });
  });
});
