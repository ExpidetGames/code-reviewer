// SPDX-License-Identifier: LicenseRef-Proprietary

// The instance admin's decision on a request to link an installation (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.9): approving links it (with the checks that still apply), denying links nothing, a
// request is decided once, and the requester finds the decision in their workspace.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import {
  createBindingHarness,
  type BindingHarness,
} from "../test-support/binding-harness.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

/** A request: the Owner of workspace A asked for the installation of `acme`, whose role GitHub does not let the app read. */
async function requested() {
  const h = await createBindingHarness({ tenancy: "multi" });
  const a = await h.workspace("a");
  const owner = await h.person("owner-a", { workspaceId: a.id, role: "owner" });
  h.githubUser(1001, "octo");
  h.github.addOrgMember("acme", "octo", "active", "admin");
  h.github.setAppAccountPermissions({ emails: "read" });
  h.install({ id: 4242, account: ACME }, ["acme/widgets", "acme/gadgets"]);
  const run = await h.walk(owner, a.id, {
    installationId: 4242,
    githubLogin: "octo",
  });
  expect(run.final).toMatchObject({ code: "waiting_for_instance_admin" });
  const [request] = await h.requests.listPending();
  if (request === undefined) throw new Error("no request was made");
  return { h, a, owner, request };
}

async function nothingLinked(h: BindingHarness) {
  expect(await h.integrationRows()).toEqual([]);
  expect(await h.repositoryRows()).toEqual([]);
}

describe("approving a request", () => {
  // #103-IB-20
  it("links the installation to the workspace of the request and reads its repositories", async () => {
    const { h, a, request } = await requested();

    const result = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );

    expect(result).toEqual({ ok: true });
    expect(await h.integrationRows()).toEqual([
      expect.objectContaining({
        workspace_id: a.id,
        external_id: "4242",
        status: "active",
      }),
    ]);
    expect((await h.repositoryRows(a.id)).map((row) => row.full_name)).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "approved",
      decidedBy: "instance-admin",
    });
    expect(await h.requests.listPending()).toEqual([]);
  });

  // #103-IB-20
  it("is the decision of one request once: a second decision, of either kind, is refused and changes nothing", async () => {
    const { h, request } = await requested();
    await h.binding.approvals.approve("instance-admin", request.id);
    const before = await h.integrationRows();

    const approvedAgain = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );
    const denied = await h.binding.approvals.deny("instance-admin", request.id);

    expect(approvedAgain).toEqual({ ok: false, error: "request_not_pending" });
    expect(denied).toEqual({ ok: false, error: "request_not_pending" });
    expect(await h.integrationRows()).toEqual(before);
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "approved",
    });
  });

  // #103-IB-20
  it("withdraws the requests of every workspace for an installation when one workspace links it, and they can no longer be approved", async () => {
    const { h, a, request } = await requested();
    h.githubUser(1003, "octo2");
    h.github.addOrgMember("acme", "octo2", "active", "admin");
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });
    // Workspace B asks for the same installation, with a role that cannot be read as well; then links it.
    h.github.setAppAccountPermissions({ emails: "read" });
    await h.walk(ownerB, b.id, { installationId: 4242, githubLogin: "octo2" });
    expect(await h.requests.listPending()).toHaveLength(2);
    h.github.setAppAccountPermissions({ emails: "read", members: "read" });
    const second = (await h.requests.listPending()).find(
      (candidate) => candidate.workspaceId === b.id,
    );
    if (second === undefined) throw new Error("no request of workspace B");
    expect(
      await h.binding.approvals.approve("instance-admin", second.id),
    ).toEqual({ ok: true });
    const linked = await h.integrationRows();

    // A's request waited for an installation that is B's now: it is closed, not left waiting forever.
    expect(await h.requests.get(request.id)).toMatchObject({
      workspaceId: a.id,
      status: "withdrawn",
    });
    expect(await h.requests.listPending()).toEqual([]);
    expect(
      await h.binding.approvals.approve("instance-admin", request.id),
    ).toEqual({ ok: false, error: "request_not_pending" });
    expect(await h.integrationRows()).toEqual(linked);
  });

  // #103-IB-20
  it("withdraws the waiting request of another workspace when a person links the installation directly", async () => {
    const { h, a, request } = await requested();
    h.githubUser(1003, "octo2");
    h.github.addOrgMember("acme", "octo2", "active", "admin");
    h.github.setAppAccountPermissions({ emails: "read", members: "read" });
    const b = await h.workspace("b");
    const ownerB = await h.person("owner-b", {
      workspaceId: b.id,
      role: "owner",
    });

    const run = await h.walk(ownerB, b.id, {
      installationId: 4242,
      githubLogin: "octo2",
    });

    expect(run.final).toMatchObject({ code: "linked" });
    expect(await h.requests.get(request.id)).toMatchObject({
      workspaceId: a.id,
      status: "withdrawn",
    });
    expect(await h.requests.listPending()).toEqual([]);
  });

  // #103-IB-20
  it("refuses an installation that was linked another way by now (the request is withdrawn, so it does not wait forever)", async () => {
    const { h, request } = await requested();
    // Linked without a person's flow, for instance by the single-tenant attach of the synchronization.
    const b = await h.workspace("b");
    await createIntegrationsRepository(h.db, b.id).create({
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
    const linked = await h.integrationRows();

    const result = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );

    expect(result).toEqual({ ok: false, error: "installation_already_linked" });
    expect(await h.integrationRows()).toEqual(linked);
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "withdrawn",
    });
    expect(await h.requests.listPending()).toEqual([]);
  });

  // #103-IB-20
  it("refuses when the person who asked is not an Owner or Admin of the workspace any more", async () => {
    const { h, owner, request } = await requested();
    await h.db
      .deleteFrom("workspace_members")
      .where("user_id", "=", owner.id)
      .execute();

    const result = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );

    expect(result).toEqual({ ok: false, error: "requester_not_admin" });
    await nothingLinked(h);
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "pending",
    });
  });

  // #103-IB-20
  it("refuses an installation GitHub does not know any more, and leaves the request waiting", async () => {
    const { h, request } = await requested();
    h.github.removeInstallation(4242);

    const result = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );

    expect(result).toEqual({ ok: false, error: "installation_not_accessible" });
    await nothingLinked(h);
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "pending",
    });
  });

  // #103-IB-20
  it("does not decide when GitHub cannot be asked, so the request can be approved later", async () => {
    const { h, request } = await requested();
    h.github.fail({ pathIncludes: "/app/installations/4242", status: 503 });

    const result = await h.binding.approvals.approve(
      "instance-admin",
      request.id,
    );

    expect(result).toEqual({ ok: false, error: "github_unreachable" });
    expect(await h.requests.get(request.id)).toMatchObject({
      status: "pending",
    });
    h.github.clearFailures();
    expect(
      await h.binding.approvals.approve("instance-admin", request.id),
    ).toEqual({ ok: true });
  });

  // #103-IB-20
  it("knows no request that does not exist", async () => {
    const { h } = await requested();

    expect(await h.binding.approvals.approve("instance-admin", "nope")).toEqual(
      {
        ok: false,
        error: "request_not_found",
      },
    );
    expect(await h.binding.approvals.deny("instance-admin", "nope")).toEqual({
      ok: false,
      error: "request_not_found",
    });
  });
});

describe("denying a request", () => {
  // #103-IB-20
  it("links nothing, and the requester finds the decision in their workspace", async () => {
    const { h, a, request } = await requested();

    const result = await h.binding.approvals.deny("instance-admin", request.id);

    expect(result).toEqual({ ok: true });
    await nothingLinked(h);
    const listed = await h.db
      .selectFrom("installation_link_requests")
      .select(["status", "decided_by"])
      .where("workspace_id", "=", a.id)
      .execute();
    expect(listed).toEqual([
      { status: "denied", decided_by: "instance-admin" },
    ]);
  });

  // #103-IB-20
  it("lets the person ask again afterwards", async () => {
    const { h, a, owner, request } = await requested();
    await h.binding.approvals.deny("instance-admin", request.id);

    await h.walk(owner, a.id, { installationId: 4242, githubLogin: "octo" });

    expect(await h.requests.listPending()).toEqual([
      expect.objectContaining({ installationId: "4242", status: "pending" }),
    ]);
  });
});

describe("the list of the admin", () => {
  // #103-IB-23
  it("holds the requests that wait with who asked, the account, and the evidence, and the decisions made", async () => {
    const { h, request } = await requested();

    const waiting = await h.binding.approvals.list();
    await h.binding.approvals.deny("instance-admin", request.id);
    const after = await h.binding.approvals.list();

    expect(waiting.decided).toEqual([]);
    expect(waiting.pending).toEqual([
      expect.objectContaining({
        workspaceName: "Workspace a",
        requesterName: "owner-a",
        requesterEmail: "owner-a@example.test",
        requesterGithubLogin: "octo",
        accountLogin: "acme",
        accountType: "Organization",
        evidence: {
          tokenCanAccess: true,
          roleResult: "unreadable",
          roleDetail: "forbidden",
        },
      }),
    ]);
    expect(after.pending).toEqual([]);
    expect(after.decided.map((entry) => entry.status)).toEqual(["denied"]);
  });

  // #103-IB-23
  it("keeps no token in a request", async () => {
    const { h } = await requested();

    const dump = JSON.stringify(
      await h.db.selectFrom("installation_link_requests").selectAll().execute(),
    );

    for (const token of h.github.issuedAccessTokens())
      expect(dump).not.toContain(token);
  });
});
