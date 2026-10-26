// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules of invitations through the real service over a real Postgres database, a real clock moved by hand,
// the real counters and a mail double: who may invite whom, which addresses may be invited, what is stored
// (a hash, never the token), how a link is used up, expires and is revoked, and who may accept. The
// refusals matter as much as the successes: each one leaves the tables as they were.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invitationLink } from "../mail/invitation-message.ts";
import {
  createWorkspaceHarness,
  WORKSPACE_TEST_BASE_URL,
  type WorkspaceHarness,
} from "../test-support/workspace-harness.ts";
import { createInvitationService, INVITATION_TTL_MS } from "./invitations.ts";
import {
  ACCEPT_PERSON_MAX,
  ACCEPT_TOKEN_MAX,
  INVITE_ADDRESS_MAX,
  INVITE_PERSON_MAX,
} from "./rate-limits.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function setup(
  options: Parameters<typeof createWorkspaceHarness>[0] = {},
) {
  const h = await createWorkspaceHarness(options);
  const workspace = await h.addWorkspace("acme");
  const owner = await h.addMember(workspace, "owner-1", "owner");
  const admin = await h.addMember(workspace, "admin-1", "admin");
  const member = await h.addMember(workspace, "member-1", "member");
  return { h, workspace, owner, admin, member };
}

function invite(
  h: WorkspaceHarness,
  workspace: { id: string; name: string },
  actorId: string,
  email: unknown,
  role: unknown = "member",
  inviterName = "An inviter",
) {
  return h.invitations.create({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    actorId,
    inviterName,
    email,
    role,
  });
}

/** Invites and returns the token that was made for the invitation. */
async function inviteForToken(
  h: WorkspaceHarness,
  workspace: { id: string; name: string },
  actorId: string,
  email: string,
  role: unknown = "member",
) {
  const result = await invite(h, workspace, actorId, email, role);
  if (!result.ok)
    throw new Error(`The invitation was refused: ${result.error}`);
  return {
    token: h.tokens.at(-1) ?? "",
    invitation: result.invitation,
    result,
  };
}

describe("creating an invitation", () => {
  // #101-WM-12
  it("stores a hash of the token, mails the link once, and keeps the token nowhere", async () => {
    const { h, workspace, owner } = await setup({ mail: true });

    const result = await invite(
      h,
      workspace,
      owner.id,
      "New@Example.TEST",
      "admin",
    );

    expect(result).toMatchObject({
      ok: true,
      delivery: { kind: "mailed" },
      invitation: { email: "new@example.test", role: "admin", expired: false },
    });
    const token = h.tokens[0] ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await h.invitationRows(workspace.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(h.mail.outbox).toHaveLength(1);
    expect(h.mail.outbox[0]).toMatchObject({ to: "new@example.test" });
    expect(h.mail.lastLink("new@example.test")).toBe(
      invitationLink(WORKSPACE_TEST_BASE_URL, token),
    );
    expect(
      new Date(rows[0]?.expires_at ?? "").getTime() -
        new Date(rows[0]?.created_at ?? "").getTime(),
    ).toBe(INVITATION_TTL_MS);
  });

  // #101-WM-13
  it("returns the link once for copying when there is no mail server, and cannot show it again", async () => {
    const { h, workspace, owner } = await setup({ mail: false });

    const result = await invite(h, workspace, owner.id, "new@example.test");

    expect(result).toMatchObject({
      ok: true,
      delivery: {
        kind: "link",
        reason: "no_mail_server",
        link: invitationLink(WORKSPACE_TEST_BASE_URL, h.tokens[0] ?? ""),
      },
    });
    expect(h.mail.outbox).toEqual([]);
    const listed = await h.invitations.listOpen(workspace.id);
    expect(JSON.stringify(listed)).not.toContain(h.tokens[0] ?? "x");
    expect(JSON.stringify(await h.invitationRows(workspace.id))).not.toContain(
      h.tokens[0] ?? "x",
    );
  });

  it("hands the link to the person who invited when the mail server refuses the message", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    h.mail.failNext();

    const result = await invite(h, workspace, owner.id, "new@example.test");

    expect(result).toMatchObject({
      ok: true,
      delivery: { kind: "link", reason: "mail_failed" },
    });
    expect(await h.invitationRows(workspace.id)).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain(h.tokens[0] ?? "x");
  });

  // #101-WM-11, #101-WM-27
  it("lets an Owner invite with any role and an Admin invite Members only", async () => {
    const { h, workspace, owner, admin } = await setup();

    for (const role of ["owner", "admin", "member"])
      expect(
        (await invite(h, workspace, owner.id, `${role}@example.test`, role)).ok,
        role,
      ).toBe(true);
    expect(
      (await invite(h, workspace, admin.id, "by-admin@example.test", "member"))
        .ok,
    ).toBe(true);
  });

  // #101-WM-11
  it("refuses an Admin to invite an Admin or an Owner, and a Member to invite anybody, creating nothing", async () => {
    const { h, workspace, admin, member } = await setup();

    const refusals = [
      await invite(h, workspace, admin.id, "a@example.test", "admin"),
      await invite(h, workspace, admin.id, "b@example.test", "owner"),
      await invite(h, workspace, member.id, "c@example.test", "member"),
      await invite(h, workspace, member.id, "d@example.test", "admin"),
    ];

    expect(refusals).toEqual(Array(4).fill({ ok: false, error: "forbidden" }));
    expect(await h.invitationRows(workspace.id)).toEqual([]);
    expect(h.mail.outbox).toEqual([]);
  });

  // #101-WM-11
  it("uses the role the person has now: a person demoted a moment ago cannot invite as before", async () => {
    const { h, workspace, owner, admin } = await setup();
    await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: owner.id,
      targetUserId: admin.id,
      role: "member",
    });

    const result = await invite(h, workspace, admin.id, "new@example.test");

    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  // #101-WM-11
  it("judges the role again inside the transaction: a person demoted while the request was on its way creates nothing", async () => {
    const { h, workspace, owner, admin } = await setup();
    // Between the first look at the role and the transaction (the counters are asked in between), the
    // Admin is demoted by an Owner.
    const racing = createInvitationService({
      db: h.db,
      mail: h.mail,
      baseUrl: "https://reviews.example.test",
      githubConfigured: () => false,
      now: h.now,
      limits: {
        ...h.limits,
        async invite(input) {
          await h.members.changeRole({
            workspaceId: workspace.id,
            actorId: owner.id,
            targetUserId: admin.id,
            role: "member",
          });
          return h.limits.invite(input);
        },
      },
    });

    const result = await racing.create({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      actorId: admin.id,
      inviterName: "Admin",
      email: "new@example.test",
      role: "member",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await h.invitationRows(workspace.id)).toEqual([]);
  });

  // #101-WM-07
  it("is not there for a person who is not a member of the workspace", async () => {
    const { h, workspace } = await setup();
    const other = await h.addWorkspace("other");
    await h.addMember(other, "other-owner", "owner");

    const result = await invite(
      h,
      workspace,
      "other-owner",
      "new@example.test",
    );

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await h.invitationRows(workspace.id)).toEqual([]);
  });

  it.each(["", "not an address", "a@b", "x@y.test\r\nBcc: z@y.test", 42, null])(
    "refuses the address %j",
    async (email) => {
      const { h, workspace, owner } = await setup();

      expect(await invite(h, workspace, owner.id, email)).toEqual({
        ok: false,
        error: "invalid_email",
      });
      expect(await h.invitationRows(workspace.id)).toEqual([]);
    },
  );

  it("refuses a role that does not exist", async () => {
    const { h, workspace, owner } = await setup();

    expect(
      await invite(h, workspace, owner.id, "new@example.test", "superuser"),
    ).toEqual({ ok: false, error: "invalid_role" });
  });
});

describe("the sign-up rule and invitations", () => {
  // #101-WM-14
  it("refuses an address the rule does not let in, creating no row and sending nothing", async () => {
    const { h, workspace, owner } = await setup({
      mail: true,
      rule: { kind: "emails", entries: ["allowed@example.test"] },
    });

    const refused = await invite(h, workspace, owner.id, "other@example.test");
    const allowed = await invite(
      h,
      workspace,
      owner.id,
      "Allowed@Example.test",
    );

    expect(refused).toEqual({ ok: false, error: "email_not_allowed" });
    expect(allowed.ok).toBe(true);
    expect(await h.invitationRows(workspace.id)).toHaveLength(1);
    expect(h.mail.outbox).toHaveLength(1);
  });

  // #101-WM-14
  it("matches a domain rule exactly: the domain, not a subdomain", async () => {
    const { h, workspace, owner } = await setup({
      mail: true,
      rule: { kind: "domains", entries: ["company.test"] },
    });

    expect((await invite(h, workspace, owner.id, "a@company.test")).ok).toBe(
      true,
    );
    expect(await invite(h, workspace, owner.id, "a@sub.company.test")).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
  });

  // #101-WM-14
  it("creates no invitation while a rule that names addresses has no way to verify them", async () => {
    const { h, workspace, owner } = await setup({
      mail: false,
      rule: { kind: "emails", entries: ["allowed@example.test"] },
    });

    const result = await invite(h, workspace, owner.id, "allowed@example.test");

    expect(result).toEqual({ ok: false, error: "signup_closed" });
    expect(await h.invitationRows(workspace.id)).toEqual([]);
  });

  it("invites again as soon as a way to verify addresses exists", async () => {
    const { h, workspace, owner } = await setup({
      mail: false,
      rule: { kind: "emails", entries: ["allowed@example.test"] },
    });
    await invite(h, workspace, owner.id, "allowed@example.test");

    h.mail.configured = true;

    expect(
      (await invite(h, workspace, owner.id, "allowed@example.test")).ok,
    ).toBe(true);
  });

  it("invites under a rule that names addresses when GitHub is the only way to sign in", async () => {
    const { h, workspace, owner } = await setup({
      mail: false,
      github: true,
      signInMethods: { emailPassword: false, github: true },
      rule: { kind: "emails", entries: ["allowed@example.test"] },
    });

    const result = await invite(h, workspace, owner.id, "allowed@example.test");

    expect(result.ok).toBe(true);
  });

  it("invites under the rule everyone even when email sign-up is switched off, because the person signs in with GitHub", async () => {
    const { h, workspace, owner } = await setup({
      github: true,
      signInMethods: { emailPassword: false, github: true },
    });

    expect(
      (await invite(h, workspace, owner.id, "anyone@example.test")).ok,
    ).toBe(true);
  });
});

describe("a rule that was tightened after the invitation was made", () => {
  async function invitedUnderEveryone(options: { mail: boolean }) {
    const context = await setup({ mail: options.mail });
    const { h, workspace, owner } = context;
    const person = await h.addUser("person", { email: "person@example.test" });
    const made = await inviteForToken(h, workspace, owner.id, person.email);
    return { ...context, person, made };
  }

  // #101-WM-14
  it("refuses to accept: invited under everyone, then the rule names other addresses, then the link does not bring the person in", async () => {
    const { h, workspace, person, made } = await invitedUnderEveryone({
      mail: true,
    });
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["somebody-else@example.test"] },
      null,
    );

    expect(await h.invitations.accept({ token: made.token }, person)).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
    // Nothing was used up: the invitation is still open for a rule that lets the address in again.
    expect(await h.invitationRows(workspace.id)).toMatchObject([
      { accepted_at: null },
    ]);
    await h.settings.set(
      "sign_up_rule",
      { kind: "domains", entries: ["example.test"] },
      null,
    );
    expect(
      await h.invitations.accept({ token: made.token }, person),
    ).toMatchObject({ ok: true });
  });

  // #101-WM-14
  it("refuses a domain rule that no longer names the domain of the address", async () => {
    const { h, person, made } = await invitedUnderEveryone({ mail: true });
    await h.settings.set(
      "sign_up_rule",
      { kind: "domains", entries: ["company.test"] },
      null,
    );

    expect(await h.invitations.accept({ token: made.token }, person)).toEqual({
      ok: false,
      error: "email_not_allowed",
    });
  });

  // #101-WM-14
  it("refuses with signup_closed when the rule names addresses and there is no mail server to verify them", async () => {
    const { h, person, made } = await invitedUnderEveryone({ mail: false });
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["person@example.test"] },
      null,
    );

    expect(await h.invitations.accept({ token: made.token }, person)).toEqual({
      ok: false,
      error: "signup_closed",
    });
  });

  // #101-WM-14
  it("refuses to accept from the list of the account in the same way", async () => {
    const { h, person, made } = await invitedUnderEveryone({ mail: true });
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["somebody-else@example.test"] },
      null,
    );

    expect(
      await h.invitations.accept({ invitationId: made.invitation.id }, person),
    ).toEqual({ ok: false, error: "email_not_allowed" });
  });

  // #101-WM-14
  it("leaves the instance admin out: their account exists whatever the rule says", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const root = await h.addUser("root", {
      email: "root@example.test",
      isInstanceAdmin: true,
    });
    const { token } = await inviteForToken(h, workspace, owner.id, root.email);
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["somebody-else@example.test"] },
      null,
    );

    expect(await h.invitations.accept({ token }, root)).toMatchObject({
      ok: true,
    });
    expect(await h.roleOf(workspace.id, root.id)).toBe("member");
  });

  // #101-WM-14
  it("sends no new link for an address the rule does not let in any more, and a revoke still works", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const made = await inviteForToken(
      h,
      workspace,
      owner.id,
      "person@example.test",
    );
    const mails = h.mail.outbox.length;
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["somebody-else@example.test"] },
      null,
    );

    const resent = await h.invitations.resend({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      actorId: owner.id,
      inviterName: "Someone",
      invitationId: made.invitation.id,
    });

    expect(resent).toEqual({ ok: false, error: "email_not_allowed" });
    expect(h.mail.outbox).toHaveLength(mails);
    expect(
      await h.invitations.revoke({
        workspaceId: workspace.id,
        actorId: owner.id,
        invitationId: made.invitation.id,
      }),
    ).toEqual({ ok: true });
  });
});

describe("addresses that are members or invited already", () => {
  // #101-WM-15
  it("refuses the address of a member, whatever its spelling", async () => {
    const { h, workspace, owner, member } = await setup();

    const result = await invite(
      h,
      workspace,
      owner.id,
      member.email.toUpperCase(),
    );

    expect(result).toEqual({ ok: false, error: "already_member" });
  });

  // #101-WM-15
  it("refuses a second invitation for a pending address, and a resend makes the old link useless", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const person = await h.addUser("person", { email: "person@example.test" });
    const first = await inviteForToken(h, workspace, owner.id, person.email);

    const again = await invite(h, workspace, owner.id, person.email);
    const resent = await h.invitations.resend({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      actorId: owner.id,
      inviterName: "Owner",
      invitationId: first.invitation.id,
    });

    expect(again).toEqual({ ok: false, error: "already_invited" });
    expect(resent).toMatchObject({ ok: true, delivery: { kind: "mailed" } });
    expect(await h.invitationRows(workspace.id)).toHaveLength(1);
    expect(h.mail.to(person.email)).toHaveLength(2);
    const second = h.tokens.at(-1) ?? "";
    expect(second).not.toBe(first.token);
    expect(await h.invitations.accept({ token: first.token }, person)).toEqual({
      ok: false,
      error: "invitation_not_found",
    });
    expect(await h.invitations.accept({ token: second }, person)).toMatchObject(
      {
        ok: true,
      },
    );
  });

  it("answers an address that has an account but no membership exactly like one without an account", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    await h.addUser("known", { email: "known@example.test" });

    const known = await invite(h, workspace, owner.id, "known@example.test");
    const unknown = await invite(
      h,
      workspace,
      owner.id,
      "unknown@example.test",
    );

    expect(known).toMatchObject({ ok: true, delivery: { kind: "mailed" } });
    expect(unknown).toMatchObject({ ok: true, delivery: { kind: "mailed" } });
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(h.mail.outbox.map((message) => message.subject)).toEqual([
      h.mail.outbox[0]?.subject,
      h.mail.outbox[0]?.subject,
    ]);
  });

  // #101-WM-16
  it("makes room for a new invitation once the old one has expired", async () => {
    const { h, workspace, owner } = await setup();
    await invite(h, workspace, owner.id, "new@example.test");
    h.advance(7 * DAY + MINUTE);

    const again = await invite(h, workspace, owner.id, "new@example.test");

    expect(again.ok).toBe(true);
    const rows = await h.invitationRows(workspace.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
  });
});

describe("how long an invitation works", () => {
  // #101-WM-16
  it("is valid after 6 days and 23 hours and expired after 7 days and a minute", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    h.advance(6 * DAY + 23 * HOUR);
    expect(await h.invitations.preview(token)).toMatchObject({ ok: true });
    h.advance(2 * HOUR + MINUTE);

    expect(await h.invitations.preview(token)).toEqual({
      ok: false,
      error: "invitation_expired",
    });
    expect(await h.invitations.accept({ token }, person)).toEqual({
      ok: false,
      error: "invitation_expired",
    });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
  });

  // #101-WM-16
  it("works until the very last moment and not a moment longer", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    h.advance(INVITATION_TTL_MS - 1);
    expect(await h.invitations.preview(token)).toMatchObject({ ok: true });
    h.advance(1);

    expect(await h.invitations.preview(token)).toEqual({
      ok: false,
      error: "invitation_expired",
    });
  });
});

describe("revoking an invitation", () => {
  // #101-WM-17
  it("makes the link answer invitation_revoked", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token, invitation } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    const revoked = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: owner.id,
      invitationId: invitation.id,
    });

    expect(revoked).toEqual({ ok: true });
    expect(await h.invitations.preview(token)).toEqual({
      ok: false,
      error: "invitation_revoked",
    });
    expect(await h.invitations.accept({ token }, person)).toEqual({
      ok: false,
      error: "invitation_revoked",
    });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
  });

  // #101-WM-11
  it("lets an Admin revoke the invitation of a Member and not the one of an Admin, and never a Member", async () => {
    const { h, workspace, owner, admin, member } = await setup();
    const forMember = await inviteForToken(
      h,
      workspace,
      owner.id,
      "m@example.test",
      "member",
    );
    const forAdmin = await inviteForToken(
      h,
      workspace,
      owner.id,
      "a@example.test",
      "admin",
    );

    const byMember = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: member.id,
      invitationId: forMember.invitation.id,
    });
    const adminOnAdmin = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: admin.id,
      invitationId: forAdmin.invitation.id,
    });
    const adminOnMember = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: admin.id,
      invitationId: forMember.invitation.id,
    });

    expect(byMember).toEqual({ ok: false, error: "forbidden" });
    expect(adminOnAdmin).toEqual({ ok: false, error: "forbidden" });
    expect(adminOnMember).toEqual({ ok: true });
    expect(await h.invitations.preview(forAdmin.token)).toMatchObject({
      ok: true,
    });
  });

  // #101-WM-07
  it("cannot reach an invitation of another workspace, by its id", async () => {
    const { h, workspace, owner } = await setup();
    const other = await h.addWorkspace("other");
    const otherOwner = await h.addMember(other, "other-owner", "owner");
    const theirs = await inviteForToken(
      h,
      other,
      otherOwner.id,
      "x@example.test",
    );

    const asForeignMember = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: owner.id,
      invitationId: theirs.invitation.id,
    });
    const asNonMember = await h.invitations.revoke({
      workspaceId: other.id,
      actorId: owner.id,
      invitationId: theirs.invitation.id,
    });

    expect(asForeignMember).toEqual({
      ok: false,
      error: "invitation_not_found",
    });
    expect(asNonMember).toEqual({ ok: false, error: "not_found" });
    expect(await h.invitations.preview(theirs.token)).toMatchObject({
      ok: true,
    });
  });

  it("cannot revoke an invitation that was accepted already", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token, invitation } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );
    await h.invitations.accept({ token }, person);

    const result = await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: owner.id,
      invitationId: invitation.id,
    });

    expect(result).toEqual({ ok: false, error: "invitation_not_found" });
    expect(await h.roleOf(workspace.id, person.id)).toBe("member");
  });
});

describe("resending an invitation", () => {
  async function pending(options: Parameters<typeof setup>[0]) {
    const context = await setup(options);
    const { h, workspace, owner } = context;
    const made = await inviteForToken(
      h,
      workspace,
      owner.id,
      "p@example.test",
      "member",
    );
    const resend = (actorId: string, invitationId = made.invitation.id) =>
      h.invitations.resend({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        actorId,
        inviterName: "Someone",
        invitationId,
      });
    return { ...context, made, resend };
  }

  // #101-WM-13
  it("is not available without a mail server: the link is shown once, a new one needs a new invitation", async () => {
    const { h, owner, made, resend } = await pending({ mail: false });

    expect(await resend(owner.id)).toEqual({
      ok: false,
      error: "not_available",
    });
    expect(await h.invitations.preview(made.token)).toMatchObject({ ok: true });
  });

  it("gives the invitation a new week and a new link", async () => {
    const { h, owner, made, resend } = await pending({ mail: true });
    h.advance(5 * DAY);

    const result = await resend(owner.id);

    expect(result).toMatchObject({ ok: true });
    h.advance(3 * DAY);
    expect(await h.invitations.preview(made.token)).toEqual({
      ok: false,
      error: "invitation_not_found",
    });
    expect(await h.invitations.preview(h.tokens.at(-1))).toMatchObject({
      ok: true,
    });
  });

  // #101-WM-11
  it("follows the same rights as inviting: an Admin cannot resend an invitation to an Admin", async () => {
    const { h, workspace, owner, admin, resend } = await pending({
      mail: true,
    });
    const forAdmin = await inviteForToken(
      h,
      workspace,
      owner.id,
      "a@example.test",
      "admin",
    );

    expect(await resend(admin.id, forAdmin.invitation.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await resend(admin.id)).toMatchObject({ ok: true });
  });

  it("does not resend a revoked or an unknown invitation", async () => {
    const { h, workspace, owner, made, resend } = await pending({ mail: true });
    await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: owner.id,
      invitationId: made.invitation.id,
    });

    expect(await resend(owner.id)).toEqual({
      ok: false,
      error: "invitation_not_found",
    });
    expect(await resend(owner.id, "nothing")).toEqual({
      ok: false,
      error: "invitation_not_found",
    });
  });
});

describe("accepting an invitation by its link", () => {
  // #101-WM-20
  it("makes the person a member with the invited role", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
      "admin",
    );

    const result = await h.invitations.accept({ token }, person);

    expect(result).toEqual({
      ok: true,
      workspace: { slug: "acme", name: workspace.name },
      role: "admin",
      alreadyMember: false,
    });
    expect(await h.roleOf(workspace.id, person.id)).toBe("admin");
  });

  // #101-WM-18
  // #101-WM-12
  it("keeps working when the person who invited has left the workspace: the invitation belongs to the workspace", async () => {
    const { h, workspace, owner, admin } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      admin.id,
      person.email,
    );
    expect(
      await h.members.remove({
        workspaceId: workspace.id,
        actorId: owner.id,
        targetUserId: admin.id,
      }),
    ).toMatchObject({ ok: true });

    expect(await h.invitations.preview(token)).toMatchObject({ ok: true });
    expect(await h.invitations.accept({ token }, person)).toMatchObject({
      ok: true,
      role: "member",
    });
  });

  it("works once: the second attempt is invitation_used and the first member keeps the role", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
      "admin",
    );
    await h.invitations.accept({ token }, person);

    const again = await h.invitations.accept({ token }, person);

    expect(again).toEqual({ ok: false, error: "invitation_used" });
    expect(await h.roleOf(workspace.id, person.id)).toBe("admin");
  });

  // #101-WM-18
  it("lets only one of two requests with one link succeed", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    const results = await Promise.all([
      h.invitations.accept({ token }, person),
      h.invitations.accept({ token }, person),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "invitation_used" },
    ]);
  });

  // #101-WM-19
  it("refuses a person who is signed in with another address, and the invitation stays open", async () => {
    const { h, workspace, owner } = await setup();
    const wrong = await h.addUser("wrong", { email: "wrong@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      "right@example.test",
    );

    const result = await h.invitations.accept({ token }, wrong);

    expect(result).toEqual({ ok: false, error: "email_mismatch" });
    expect(await h.roleOf(workspace.id, wrong.id)).toBeUndefined();
    expect(await h.invitations.preview(token)).toMatchObject({ ok: true });
  });

  // #101-WM-19
  it("refuses the right address while it is unverified and a mail server exists, and accepts once it is verified", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const person = await h.addUser("person", {
      email: "person@example.test",
      verified: false,
    });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    const refused = await h.invitations.accept({ token }, person);
    const accepted = await h.invitations.accept(
      { token },
      { ...person, emailVerified: true },
    );

    expect(refused).toEqual({ ok: false, error: "email_not_verified" });
    expect(accepted).toMatchObject({ ok: true });
  });

  // #101-WM-20
  it("accepts an unverified address without a mail server under the rule everyone: the link is the proof", async () => {
    const { h, workspace, owner } = await setup({ mail: false });
    const person = await h.addUser("person", {
      email: "person@example.test",
      verified: false,
    });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    expect(await h.invitations.accept({ token }, person)).toMatchObject({
      ok: true,
      role: "member",
    });
  });

  // #99-follow-up
  it("requires a verified address under a rule that names addresses", async () => {
    const { h, workspace, owner } = await setup({
      mail: true,
      rule: { kind: "emails", entries: ["person@example.test"] },
    });
    const person = await h.addUser("person", {
      email: "person@example.test",
      verified: false,
    });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    expect(await h.invitations.accept({ token }, person)).toEqual({
      ok: false,
      error: "email_not_verified",
    });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
  });

  it("is closed again, with the rule's own answer, when the mail server is gone under a rule that names addresses", async () => {
    const { h, workspace, owner } = await setup({
      mail: true,
      rule: { kind: "emails", entries: ["person@example.test"] },
    });
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );
    h.mail.configured = false;

    expect(await h.invitations.accept({ token }, person)).toEqual({
      ok: false,
      error: "signup_closed",
    });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
  });

  // #99-follow-up
  it("lets the instance admin accept with an unverified address", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const admin = await h.addUser("root", {
      email: "root@example.test",
      verified: false,
      isInstanceAdmin: true,
    });
    const { token } = await inviteForToken(h, workspace, owner.id, admin.email);

    expect(await h.invitations.accept({ token }, admin)).toMatchObject({
      ok: true,
    });
  });

  // #101-WM-25
  it("changes nothing about the role of a person who is a member already", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
      "admin",
    );
    // They joined by another way while the invitation was open, as a Member.
    await h.workspaces.addMember(workspace.id, person.id, "member");

    const result = await h.invitations.accept({ token }, person);

    expect(result).toMatchObject({
      ok: true,
      role: "member",
      alreadyMember: true,
    });
    expect(await h.roleOf(workspace.id, person.id)).toBe("member");
    expect(await h.invitations.preview(token)).toEqual({
      ok: false,
      error: "invitation_used",
    });
  });

  // #101-WM-25
  it("does not downgrade an Owner who accepts an invitation as Member", async () => {
    const { h, workspace, owner } = await setup();
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      "p@example.test",
    );
    const boss = await h.addUser("boss", { email: "p@example.test" });
    await h.workspaces.addMember(workspace.id, boss.id, "owner");

    await h.invitations.accept({ token }, boss);

    expect(await h.roleOf(workspace.id, boss.id)).toBe("owner");
  });

  // #101-WM-23
  it("answers a tampered or unknown token with one generic answer", async () => {
    const { h, workspace, owner } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const bad of [
      tampered,
      "x",
      "",
      42,
      null,
      "A".repeat(43),
      `${token} `,
    ]) {
      expect(
        await h.invitations.accept({ token: bad }, person),
        String(bad),
      ).toEqual({ ok: false, error: "invitation_not_found" });
      expect(await h.invitations.preview(bad), String(bad)).toEqual({
        ok: false,
        error: "invitation_not_found",
      });
    }
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
  });

  // #101-WM-23
  it("limits many attempts of a person, tampered tokens included", async () => {
    const { h } = await setup();
    const person = await h.addUser("person", { email: "person@example.test" });

    let last: unknown;
    for (let attempt = 0; attempt <= ACCEPT_PERSON_MAX; attempt += 1)
      last = await h.invitations.accept({ token: "A".repeat(43) }, person);

    expect(last).toMatchObject({ ok: false, error: "rate_limited" });
    expect(
      (last as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  // #101-WM-23
  it("limits the attempts against one invitation, and junk tokens do not use them up", async () => {
    const { h, workspace, owner } = await setup();
    const wrong = await h.addUser("wrong", { email: "wrong@example.test" });
    const { token } = await inviteForToken(
      h,
      workspace,
      owner.id,
      "right@example.test",
    );
    const person = await h.addUser("right", { email: "right@example.test" });
    for (let junk = 0; junk < 5; junk += 1)
      await h.invitations.accept({ token: "B".repeat(43) }, wrong);

    for (let attempt = 0; attempt < ACCEPT_TOKEN_MAX; attempt += 1)
      expect(await h.invitations.accept({ token }, wrong)).toEqual({
        ok: false,
        error: "email_mismatch",
      });
    const over = await h.invitations.accept({ token }, wrong);

    expect(over).toMatchObject({ ok: false, error: "rate_limited" });
    // The counter of the invitation does not stop at the person; the right person is limited by it too,
    // which is the price of a limit per link, and the window is a day.
    expect(await h.invitations.accept({ token }, person)).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
    h.advance(DAY + MINUTE);
    expect(await h.invitations.accept({ token }, person)).toMatchObject({
      ok: true,
    });
  });

  // #101-WM-24
  it("logs no token, whatever happens", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    h.mail.failNext();
    await invite(h, workspace, owner.id, "p@example.test");
    const person = await h.addUser("person", { email: "p@example.test" });
    await h.invitations.accept({ token: h.tokens[0] }, person);
    await h.invitations.accept({ token: h.tokens[0] }, person);

    for (const token of h.tokens)
      expect(h.logs.join("\n")).not.toContain(token);
  });
});

describe("the list of pending invitations of an account", () => {
  // #101-WM-21
  it("shows a verified account the invitations for its address when a mail server exists, and accepting from the list works", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const person = await h.addUser("person", { email: "Person@Example.test" });
    await inviteForToken(
      h,
      workspace,
      owner.id,
      "person@example.test",
      "admin",
    );

    const listed = await h.invitations.listPendingFor(person);
    const accepted = await h.invitations.accept(
      { invitationId: listed[0]?.id },
      person,
    );

    expect(listed).toEqual([
      expect.objectContaining({ workspaceName: workspace.name, role: "admin" }),
    ]);
    expect(accepted).toMatchObject({ ok: true, role: "admin" });
    expect(await h.invitations.listPendingFor(person)).toEqual([]);
  });

  // #101-WM-21
  it("shows an account with an unverified address nothing and refuses to accept from the list", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const person = await h.addUser("person", {
      email: "person@example.test",
      verified: false,
    });
    const { invitation } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    expect(await h.invitations.listPendingFor(person)).toEqual([]);
    expect(
      await h.invitations.accept({ invitationId: invitation.id }, person),
    ).toEqual({ ok: false, error: "invitation_not_found" });
    expect(
      await h.invitations.accept(
        { invitationId: invitation.id },
        { ...person, isInstanceAdmin: true },
      ),
    ).toEqual({ ok: false, error: "invitation_not_found" });
  });

  // #101-WM-28
  it("finds nothing by address without a mail server: the invitation is not listed and cannot be accepted by its id", async () => {
    const { h, workspace, owner } = await setup({ mail: false });
    const person = await h.addUser("person", { email: "person@example.test" });
    const { token, invitation } = await inviteForToken(
      h,
      workspace,
      owner.id,
      person.email,
    );

    expect(await h.invitations.listPendingFor(person)).toEqual([]);
    expect(
      await h.invitations.accept({ invitationId: invitation.id }, person),
    ).toEqual({ ok: false, error: "invitation_not_found" });
    expect(await h.roleOf(workspace.id, person.id)).toBeUndefined();
    expect(await h.invitations.accept({ token }, person)).toMatchObject({
      ok: true,
    });
  });

  it("does not show or accept the invitation of another address from the list", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const other = await h.addUser("other", { email: "other@example.test" });
    const { invitation } = await inviteForToken(
      h,
      workspace,
      owner.id,
      "person@example.test",
    );

    expect(await h.invitations.listPendingFor(other)).toEqual([]);
    expect(
      await h.invitations.accept({ invitationId: invitation.id }, other),
    ).toEqual({ ok: false, error: "invitation_not_found" });
  });

  it("leaves out invitations that expired, were revoked or were used", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    const person = await h.addUser("person", { email: "person@example.test" });
    const first = await inviteForToken(h, workspace, owner.id, person.email);
    await h.invitations.revoke({
      workspaceId: workspace.id,
      actorId: owner.id,
      invitationId: first.invitation.id,
    });
    expect(await h.invitations.listPendingFor(person)).toEqual([]);
    await inviteForToken(h, workspace, owner.id, person.email);
    h.advance(8 * DAY);

    expect(await h.invitations.listPendingFor(person)).toEqual([]);
  });
});

describe("the limits on creating invitations", () => {
  // #101-SEC-RATE
  it("stops a person after 30 invitations in an hour and says when to try again", async () => {
    const { h, workspace, owner } = await setup();
    for (let n = 0; n < INVITE_PERSON_MAX; n += 1)
      expect(
        (await invite(h, workspace, owner.id, `p${String(n)}@example.test`)).ok,
      ).toBe(true);

    const result = await invite(
      h,
      workspace,
      owner.id,
      "one-more@example.test",
    );

    expect(result).toMatchObject({ ok: false, error: "rate_limited" });
    h.advance(HOUR + MINUTE);
    expect(
      (await invite(h, workspace, owner.id, "one-more@example.test")).ok,
    ).toBe(true);
  });

  // #101-SEC-RATE
  it("stops mail to one address across invitations, so nobody can flood an inbox", async () => {
    const { h, workspace, owner } = await setup({ mail: true });
    for (let n = 0; n < INVITE_ADDRESS_MAX; n += 1) {
      const made = await invite(h, workspace, owner.id, "victim@example.test");
      if (!made.ok) throw new Error(`refused at ${String(n)}: ${made.error}`);
      await h.invitations.revoke({
        workspaceId: workspace.id,
        actorId: owner.id,
        invitationId: made.invitation.id,
      });
    }

    const result = await invite(h, workspace, owner.id, "victim@example.test");

    expect(result).toMatchObject({ ok: false, error: "rate_limited" });
    expect(h.mail.to("victim@example.test")).toHaveLength(INVITE_ADDRESS_MAX);
  });

  // #101-SEC-RATE
  it("lets a refused Member burn no counter", async () => {
    const { h, workspace, member } = await setup();
    for (let n = 0; n < INVITE_PERSON_MAX + 5; n += 1)
      expect(await invite(h, workspace, member.id, "x@example.test")).toEqual({
        ok: false,
        error: "forbidden",
      });
  });
});

describe("text that somebody else typed, in a mail", () => {
  // #101-SEC-CRLF
  it("cannot start a new mail header or a new line through the name of the person who invites", async () => {
    const { h, workspace, owner } = await setup({ mail: true });

    await invite(
      h,
      workspace,
      owner.id,
      "p@example.test",
      "member",
      "Evil\r\nBcc: attacker@example.test",
    );

    const message = h.mail.outbox[0];
    expect(message?.subject).not.toMatch(/[\r\n]/);
    expect(message?.text).not.toMatch(/^Bcc:/m);
    expect(message?.text).not.toContain("\r");
    expect(message?.html).not.toMatch(/[\r\n]Bcc:/);
  });

  // #101-SEC-CRLF
  it("escapes markup in the names in the HTML alternative", async () => {
    const { h, workspace, owner } = await setup({ mail: true });

    await invite(
      h,
      { id: workspace.id, name: "<script>alert(1)</script>" },
      owner.id,
      "p@example.test",
      "member",
      '"><img src=x onerror=alert(1)>',
    );

    const html = h.mail.outbox[0]?.html ?? "";
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
