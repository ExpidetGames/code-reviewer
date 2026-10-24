// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of workspaces, members and invitations, through the real services over a
// real SQLite file: how a request is read (same site, JSON only, a size limit, read once), what each route
// answers for a success and for each refusal, that a refusal changes nothing, and that nothing secret is in
// an answer that is not meant to carry it. Who may do what is proven where the rules are
// (members.integration.test.ts, invitations.integration.test.ts); here it is proven that the routes pass it
// on and that the answers are the documented ones.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { sessionUser } from "../test-support/session-lookup.ts";
import {
  createWorkspaceHarness,
  type WorkspaceHarness,
} from "../test-support/workspace-harness.ts";
import type { WorkspaceAccess } from "./access.ts";
import { WORKSPACE_REQUEST_MAX_BYTES } from "./http.ts";
import type { WorkspaceRole } from "./roles.ts";

function json(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function team(
  options: Parameters<typeof createWorkspaceHarness>[0] = {},
) {
  const h = await createWorkspaceHarness(options);
  const workspace = await h.addWorkspace("acme");
  await h.addMember(workspace, "owner-1", "owner");
  await h.addMember(workspace, "admin-1", "admin");
  await h.addMember(workspace, "member-1", "member");
  const as = (id: string, role: WorkspaceRole): WorkspaceAccess => ({
    user: sessionUser(id, { name: `Name of ${id}` }),
    workspace,
    role,
  });
  return {
    h,
    workspace,
    owner: as("owner-1", "owner"),
    admin: as("admin-1", "admin"),
    member: as("member-1", "member"),
  };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("how a request is read", () => {
  // #101-SEC-PARSER
  it.each([
    [
      "a request from another site",
      { "sec-fetch-site": "cross-site" },
      403,
      "cross_site_request",
    ],
    [
      "a request from a sibling site",
      { "sec-fetch-site": "same-site" },
      403,
      "cross_site_request",
    ],
    [
      "a form encoded body",
      { "content-type": "application/x-www-form-urlencoded" },
      415,
      "unsupported_content_type",
    ],
    [
      "a plain text body",
      { "content-type": "text/plain" },
      415,
      "unsupported_content_type",
    ],
  ] as const)(
    "refuses %s for every route that reads a body, before anything is done",
    async (_name, headers, status, code) => {
      const t = await team({ mail: true });
      const requests = [
        () => t.h.handlers.rename(json({ name: "X" }, headers), t.owner),
        () =>
          t.h.handlers.changeRole(
            json({ role: "member" }, headers),
            t.owner,
            "member-1",
          ),
        () =>
          t.h.handlers.invite(
            json({ email: "a@example.test", role: "member" }, headers),
            t.owner,
          ),
        () => t.h.handlers.create(json({ name: "X" }, headers), t.owner.user),
        () =>
          t.h.handlers.accept(
            json({ token: "A".repeat(43) }, headers),
            t.owner.user,
          ),
      ];

      for (const call of requests) {
        const response = await call();
        expect(response.status).toBe(status);
        expect(await body(response)).toEqual({ error: code });
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(await t.h.invitationRows(t.workspace.id)).toEqual([]);
      expect((await t.h.workspaces.get(t.workspace.id))?.name).toBe(
        "Workspace acme",
      );
      expect(t.h.mail.outbox).toEqual([]);
    },
  );

  // #101-SEC-PARSER
  it("refuses a body that is too large, not JSON, or not an object", async () => {
    const t = await team();
    const tooLarge = json({ name: "x".repeat(WORKSPACE_REQUEST_MAX_BYTES) });

    const responses = [
      await t.h.handlers.rename(tooLarge, t.owner),
      await t.h.handlers.rename(json("{not json"), t.owner),
      await t.h.handlers.rename(json("[]"), t.owner),
      await t.h.handlers.rename(json("null"), t.owner),
      await t.h.handlers.rename(json('"text"'), t.owner),
    ];

    expect(responses.map((response) => response.status)).toEqual([
      413, 422, 422, 422, 422,
    ]);
    expect(await body(responses[0] as Response)).toEqual({
      error: "body_too_large",
    });
    expect(await body(responses[1] as Response)).toEqual({
      error: "invalid_input",
    });
  });

  // #101-SEC-PARSER
  it("reads the body once: a duplicate key counts as the JSON parser reads it, the value the service gets", async () => {
    const t = await team();

    const response = await t.h.handlers.rename(
      json('{"name":"First","name":"Second"}'),
      t.owner,
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ ok: true, name: "Second" });
  });

  it("refuses to remove, revoke and resend from another site", async () => {
    const t = await team({ mail: true });
    const created = await t.h.invitations.create({
      workspaceId: t.workspace.id,
      workspaceName: t.workspace.name,
      actorId: "owner-1",
      inviterName: "Owner",
      email: "p@example.test",
      role: "member",
    });
    if (!created.ok) throw new Error("setup failed");
    const crossSite = { "sec-fetch-site": "cross-site" };
    const request = (method: string) =>
      new Request("https://app.test/api/x", { method, headers: crossSite });

    const responses = [
      await t.h.handlers.removeMember(request("DELETE"), t.owner, "member-1"),
      await t.h.handlers.revokeInvitation(
        request("DELETE"),
        t.owner,
        created.invitation.id,
      ),
      await t.h.handlers.resendInvitation(
        request("POST"),
        t.owner,
        created.invitation.id,
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: "cross_site_request" });
    }
    expect(await t.h.roleOf(t.workspace.id, "member-1")).toBe("member");
    expect(await t.h.invitations.listOpen(t.workspace.id)).toHaveLength(1);
  });
});

describe("renaming", () => {
  // #101-WM-27
  it("answers the new name for an Owner and 403 forbidden for an Admin", async () => {
    const t = await team();

    const ok = await t.h.handlers.rename(json({ name: " Better " }), t.owner);
    const refused = await t.h.handlers.rename(json({ name: "Worse" }), t.admin);

    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({ ok: true, name: "Better" });
    expect(refused.status).toBe(403);
    expect(await body(refused)).toEqual({ error: "forbidden" });
    expect((await t.h.workspaces.get(t.workspace.id))?.name).toBe("Better");
  });

  it("refuses a name that is not a name with 422 invalid_name", async () => {
    const t = await team();

    for (const name of ["", "   ", 42, null, "a\nb", "x".repeat(81)]) {
      const response = await t.h.handlers.rename(json({ name }), t.owner);
      expect(response.status).toBe(422);
      expect(await body(response)).toEqual({ error: "invalid_name" });
    }
  });
});

describe("deleting the workspace", () => {
  // #658-T03
  it("answers ok for the Owner who types the name, and the workspace is gone for everybody", async () => {
    const t = await team();

    const response = await t.h.handlers.deleteWorkspace(
      json({ confirmName: t.workspace.name }),
      t.owner,
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await t.h.workspaces.listForUser("owner-1")).toEqual([]);
    expect(await t.h.workspaces.listForUser("admin-1")).toEqual([]);
    expect(await t.h.workspaces.slugExists("acme")).toBe(false);
  });

  // #658-T02
  it("answers 403 forbidden for an Admin and a Member, and the workspace stays", async () => {
    const t = await team();

    for (const access of [t.admin, t.member]) {
      const response = await t.h.handlers.deleteWorkspace(
        json({ confirmName: t.workspace.name }),
        access,
      );
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: "forbidden" });
    }

    expect((await t.h.workspaces.get(t.workspace.id))?.name).toBe(
      t.workspace.name,
    );
    expect(await t.h.workspaces.slugExists("acme")).toBe(true);
  });

  // #658-T03
  it("answers 422 name_mismatch for a name that is not the workspace's, and 422 for a body that is no JSON object", async () => {
    const t = await team();

    for (const confirmName of ["", "Acme", undefined, 7]) {
      const response = await t.h.handlers.deleteWorkspace(
        json({ confirmName }),
        t.owner,
      );
      expect(response.status).toBe(422);
      expect(await body(response)).toEqual({ error: "name_mismatch" });
    }
    const broken = await t.h.handlers.deleteWorkspace(json("[]"), t.owner);
    expect(broken.status).toBeGreaterThanOrEqual(400);
    expect(await t.h.workspaces.slugExists("acme")).toBe(true);
  });

  it("refuses a request from another site before anything is done", async () => {
    const t = await team();

    const response = await t.h.handlers.deleteWorkspace(
      json(
        { confirmName: t.workspace.name },
        { "sec-fetch-site": "cross-site" },
      ),
      t.owner,
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "cross_site_request" });
    expect(await t.h.workspaces.slugExists("acme")).toBe(true);
  });

  // #658-T04
  it("answers 409 balance_positive while the workspace has unused credit", async () => {
    const t = await team();
    await createBillingJournalRepository(t.h.db, t.workspace.id).append({
      type: "top_up",
      amountMicroUsd: 10_000_000,
      refKey: "payment-1",
    });

    const response = await t.h.handlers.deleteWorkspace(
      json({ confirmName: t.workspace.name }),
      t.owner,
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: "balance_positive" });
    expect(await t.h.workspaces.slugExists("acme")).toBe(true);
  });

  // #658-T04
  it("answers 409 balance_negative while the workspace owes an amount", async () => {
    const t = await team();
    await createBillingJournalRepository(t.h.db, t.workspace.id).append({
      type: "correction",
      amountMicroUsd: -1_000,
      refKey: "debt-1",
    });

    const response = await t.h.handlers.deleteWorkspace(
      json({ confirmName: t.workspace.name }),
      t.owner,
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: "balance_negative" });
    expect(await t.h.workspaces.slugExists("acme")).toBe(true);
  });
});

describe("members", () => {
  // #101-WM-09
  it("answers 409 last_owner for the only Owner who leaves or is demoted", async () => {
    const t = await team();

    const leave = await t.h.handlers.removeMember(
      new Request("https://app.test/x", { method: "DELETE" }),
      t.owner,
      "owner-1",
    );
    const demote = await t.h.handlers.changeRole(
      json({ role: "admin" }),
      t.owner,
      "owner-1",
    );

    expect(leave.status).toBe(409);
    expect(await body(leave)).toEqual({ error: "last_owner" });
    expect(demote.status).toBe(409);
    expect(await body(demote)).toEqual({ error: "last_owner" });
  });

  // #101-WM-11
  it("answers 403 forbidden for an Admin who changes a role or removes an Owner, and 404 for a person who is not in the workspace", async () => {
    const t = await team();
    await t.h.addUser("stranger");
    const del = (id: string, access: WorkspaceAccess) =>
      t.h.handlers.removeMember(
        new Request("https://app.test/x", { method: "DELETE" }),
        access,
        id,
      );

    const promote = await t.h.handlers.changeRole(
      json({ role: "owner" }),
      t.admin,
      "admin-1",
    );
    const removeOwner = await del("owner-1", t.admin);
    const unknown = await t.h.handlers.changeRole(
      json({ role: "member" }),
      t.owner,
      "stranger",
    );

    expect(promote.status).toBe(403);
    expect(removeOwner.status).toBe(403);
    expect(unknown.status).toBe(404);
    expect(await body(unknown)).toEqual({ error: "member_not_found" });
    expect(await t.h.roleOf(t.workspace.id, "admin-1")).toBe("admin");
  });

  it("changes a role and lets a Member leave, answering what happened", async () => {
    const t = await team();

    const changed = await t.h.handlers.changeRole(
      json({ role: "admin" }),
      t.owner,
      "member-1",
    );
    const left = await t.h.handlers.removeMember(
      new Request("https://app.test/x", { method: "DELETE" }),
      t.member,
      "member-1",
    );

    expect(await body(changed)).toEqual({ ok: true, changed: true });
    expect(await body(left)).toEqual({ ok: true, left: true });
    expect(await t.h.roleOf(t.workspace.id, "member-1")).toBeUndefined();
  });

  it("refuses a role that is not one with 422 invalid_role", async () => {
    const t = await team();

    for (const role of ["root", "", 1, null, undefined]) {
      const response = await t.h.handlers.changeRole(
        json({ role }),
        t.owner,
        "member-1",
      );
      expect(response.status).toBe(422);
      expect(await body(response)).toEqual({ error: "invalid_role" });
    }
  });
});

describe("inviting", () => {
  // #101-WM-12
  it("answers the invitation and that the link was mailed, and the answer holds no token", async () => {
    const t = await team({ mail: true });

    const response = await t.h.handlers.invite(
      json({ email: "New@Example.test", role: "member" }),
      t.admin,
    );
    const answer = await body(response);

    expect(response.status).toBe(200);
    expect(answer).toMatchObject({
      ok: true,
      invitation: { email: "new@example.test", role: "member" },
      delivery: { kind: "mailed" },
    });
    expect(JSON.stringify(answer)).not.toContain(t.h.tokens[0] ?? "x");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // #101-WM-13
  it("answers the link once when there is no mail server", async () => {
    const t = await team({ mail: false });

    const response = await t.h.handlers.invite(
      json({ email: "new@example.test", role: "member" }),
      t.owner,
    );
    const answer = (await body(response)) as {
      delivery: { kind: string; link: string };
    };

    expect(answer.delivery.kind).toBe("link");
    expect(answer.delivery.link).toContain(t.h.tokens[0] ?? "x");
    const again = await t.h.handlers.invite(
      json({ email: "new@example.test", role: "member" }),
      t.owner,
    );
    expect(again.status).toBe(409);
    expect(await body(again)).toEqual({ error: "already_invited" });
  });

  // #101-WM-11, #101-WM-14
  it.each([
    [
      "a Member invites",
      "member",
      { email: "a@example.test", role: "member" },
      403,
      "forbidden",
    ],
    [
      "an Admin invites an Admin",
      "admin",
      { email: "a@example.test", role: "admin" },
      403,
      "forbidden",
    ],
    [
      "an address that is not an address",
      "owner",
      { email: "nope", role: "member" },
      422,
      "invalid_email",
    ],
    [
      "a role that is not one",
      "owner",
      { email: "a@example.test", role: "boss" },
      422,
      "invalid_role",
    ],
    ["no body fields at all", "owner", {}, 422, "invalid_role"],
  ] as const)(
    "answers %s with %s",
    async (_name, who, request, status, code) => {
      const t = await team({ mail: true });

      const response = await t.h.handlers.invite(json(request), t[who]);

      expect(response.status).toBe(status);
      expect(await body(response)).toEqual({ error: code });
      expect(await t.h.invitationRows(t.workspace.id)).toEqual([]);
    },
  );

  // #101-WM-14
  it("answers 422 email_not_allowed for an address the rule refuses", async () => {
    const t = await team({
      mail: true,
      rule: { kind: "domains", entries: ["company.test"] },
    });

    const response = await t.h.handlers.invite(
      json({ email: "a@other.test", role: "member" }),
      t.owner,
    );

    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ error: "email_not_allowed" });
  });

  // #101-SEC-RATE
  it("answers 429 with Retry-After when a limit is reached", async () => {
    const t = await team({ mail: true });
    let last: Response | undefined;
    for (let n = 0; n < 31; n += 1)
      last = await t.h.handlers.invite(
        json({ email: `p${String(n)}@example.test`, role: "member" }),
        t.owner,
      );

    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await body(last as Response)).toEqual({ error: "rate_limited" });
  });

  it("revokes and resends, and answers an invitation that is not there with 404", async () => {
    const t = await team({ mail: true });
    const made = (await body(
      await t.h.handlers.invite(
        json({ email: "p@example.test", role: "member" }),
        t.admin,
      ),
    )) as { invitation: { id: string } };
    const post = new Request("https://app.test/x", { method: "POST" });
    const del = new Request("https://app.test/x", { method: "DELETE" });

    const resent = await t.h.handlers.resendInvitation(
      post,
      t.admin,
      made.invitation.id,
    );
    const revoked = await t.h.handlers.revokeInvitation(
      del,
      t.admin,
      made.invitation.id,
    );
    const gone = await t.h.handlers.revokeInvitation(
      del,
      t.admin,
      made.invitation.id,
    );
    const unknown = await t.h.handlers.resendInvitation(
      post,
      t.admin,
      "nothing",
    );

    expect(resent.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(gone.status).toBe(404);
    expect(await body(gone)).toEqual({ error: "invitation_not_found" });
    expect(unknown.status).toBe(404);
  });

  it("answers a resend without a mail server with 404 not_available", async () => {
    const t = await team({ mail: false });
    const made = (await body(
      await t.h.handlers.invite(
        json({ email: "p@example.test", role: "member" }),
        t.admin,
      ),
    )) as { invitation: { id: string } };

    const response = await t.h.handlers.resendInvitation(
      new Request("https://app.test/x", { method: "POST" }),
      t.admin,
      made.invitation.id,
    );

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "not_available" });
  });
});

describe("creating a workspace", () => {
  // #101-WM-01, #101-WM-03
  it("creates it for the person, who is its Owner, and answers its address", async () => {
    const t = await team();
    await t.h.addUser("newcomer");

    const response = await t.h.handlers.create(
      json({ name: "Team B" }),
      sessionUser("newcomer"),
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      ok: true,
      workspace: { slug: "team-b", name: "Team B" },
    });
    expect(
      (await t.h.workspaces.findMembership("newcomer", "team-b"))?.role,
    ).toBe("owner");
  });

  // #101-WM-05
  it("answers 409 multi_tenant_required on a single-tenant instance and creates nothing", async () => {
    const t = await team({ tenancy: "single" });
    await t.h.addUser("newcomer");

    const response = await t.h.handlers.create(
      json({ name: "Team B" }),
      sessionUser("newcomer"),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: "multi_tenant_required" });
    expect(await t.h.workspaces.listForUser("newcomer")).toEqual([]);
  });

  // #101-WM-04
  it("answers 409 workspace_limit_reached at the limit, and 422 for a name that is not a name", async () => {
    const t = await team();
    await t.h.addUser("newcomer");
    await t.h.settings.set("max_workspaces_per_user", 1, null);
    const person = sessionUser("newcomer");

    const first = await t.h.handlers.create(json({ name: "One" }), person);
    const second = await t.h.handlers.create(json({ name: "Two" }), person);
    const invalid = await t.h.handlers.create(json({ name: "A\r\nB" }), person);
    const missing = await t.h.handlers.create(json({}), person);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await body(second)).toEqual({ error: "workspace_limit_reached" });
    expect(invalid.status).toBe(422);
    expect(missing.status).toBe(422);
  });

  // #101-SEC-RATE
  it("answers 429 when a person creates workspaces too fast", async () => {
    const t = await team();
    await t.h.addUser("newcomer");
    await t.h.settings.set("max_workspaces_per_user", 100, null);
    let last: Response | undefined;
    for (let n = 0; n < 11; n += 1)
      last = await t.h.handlers.create(
        json({ name: `Team ${String(n)}` }),
        sessionUser("newcomer"),
      );

    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });
});

async function pending(
  h: WorkspaceHarness,
  workspaceId: string,
  workspaceName: string,
  email: string,
) {
  const made = await h.invitations.create({
    workspaceId,
    workspaceName,
    actorId: "owner-1",
    inviterName: "Owner",
    email,
    role: "member",
  });
  if (!made.ok) throw new Error(`setup failed: ${made.error}`);
  return { token: h.tokens.at(-1) ?? "", id: made.invitation.id };
}

describe("accepting", () => {
  // #101-WM-20
  it("makes the signed in person a member and answers the workspace", async () => {
    const t = await team();
    await t.h.addUser("newcomer", { email: "newcomer@example.test" });
    const { token } = await pending(
      t.h,
      t.workspace.id,
      t.workspace.name,
      "newcomer@example.test",
    );

    const response = await t.h.handlers.accept(
      json({ token }),
      sessionUser("newcomer"),
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      ok: true,
      workspace: { slug: "acme", name: "Workspace acme" },
      role: "member",
      alreadyMember: false,
    });
    expect(await t.h.roleOf(t.workspace.id, "newcomer")).toBe("member");
  });

  // #101-WM-18, #101-WM-19, #101-WM-17
  it.each([
    ["the second time", "invitation_used", 409],
    ["with another address", "email_mismatch", 403],
  ] as const)("answers %s with %s", async (when, code, status) => {
    const t = await team();
    await t.h.addUser("newcomer", { email: "newcomer@example.test" });
    await t.h.addUser("other", { email: "other@example.test" });
    const { token } = await pending(
      t.h,
      t.workspace.id,
      t.workspace.name,
      "newcomer@example.test",
    );
    if (when === "the second time")
      await t.h.handlers.accept(json({ token }), sessionUser("newcomer"));

    const response = await t.h.handlers.accept(
      json({ token }),
      sessionUser(when === "the second time" ? "newcomer" : "other"),
    );

    expect(response.status).toBe(status);
    expect(await body(response)).toEqual({ error: code });
  });

  it("answers 404 invitation_not_found for a token that is damaged or unknown, with one answer for all", async () => {
    const t = await team();
    await t.h.addUser("newcomer", { email: "newcomer@example.test" });

    for (const token of ["short", "A".repeat(43), 42, null]) {
      const response = await t.h.handlers.accept(
        json({ token }),
        sessionUser("newcomer"),
      );
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual({ error: "invitation_not_found" });
    }
  });

  it("wants exactly one of a token and an invitation id", async () => {
    const t = await team();
    await t.h.addUser("newcomer", { email: "newcomer@example.test" });

    for (const request of [{}, { token: "A".repeat(43), invitationId: "x" }]) {
      const response = await t.h.handlers.accept(
        json(request),
        sessionUser("newcomer"),
      );
      expect(response.status).toBe(422);
      expect(await body(response)).toEqual({ error: "invalid_request" });
    }
  });

  // #101-WM-21, #101-WM-28
  it("accepts from the list only with a mail server, for a verified address", async () => {
    const withMail = await team({ mail: true });
    await withMail.h.addUser("newcomer", { email: "newcomer@example.test" });
    const { id } = await pending(
      withMail.h,
      withMail.workspace.id,
      withMail.workspace.name,
      "newcomer@example.test",
    );
    const withoutMail = await team({ mail: false });
    await withoutMail.h.addUser("newcomer", { email: "newcomer@example.test" });
    const other = await pending(
      withoutMail.h,
      withoutMail.workspace.id,
      withoutMail.workspace.name,
      "newcomer@example.test",
    );

    const listed = await withMail.h.handlers.accept(
      json({ invitationId: id }),
      sessionUser("newcomer"),
    );
    const byId = await withoutMail.h.handlers.accept(
      json({ invitationId: other.id }),
      sessionUser("newcomer"),
    );

    expect(listed.status).toBe(200);
    expect(byId.status).toBe(404);
    expect(
      await withoutMail.h.roleOf(withoutMail.workspace.id, "newcomer"),
    ).toBeUndefined();
  });

  it("answers an account that is gone with the generic 404", async () => {
    const t = await team();

    const response = await t.h.handlers.accept(
      json({ token: "A".repeat(43) }),
      sessionUser("ghost"),
    );

    expect(response.status).toBe(404);
  });

  // #101-WM-23
  it("answers 429 with Retry-After for a person who tries too many tokens", async () => {
    const t = await team();
    await t.h.addUser("newcomer", { email: "newcomer@example.test" });
    let last: Response | undefined;
    for (let n = 0; n < 31; n += 1)
      last = await t.h.handlers.accept(
        json({ token: "A".repeat(43) }),
        sessionUser("newcomer"),
      );

    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
