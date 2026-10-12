// SPDX-License-Identifier: Apache-2.0

// An invitation and the sign-up of the person it is for, through the real sign-up, the real Better Auth and
// a real SQLite file: the invitation does not override the sign-up rule. A rule that is tightened after the
// invitation was made still decides whether the person can create an account; and a person who signs up with
// the invited address (no mail server, rule "everyone") accepts with the link and becomes a member.
import { describe, expect, it } from "vitest";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { assembleWorkspaces } from "./assemble.ts";
import {
  createSignUpHarness,
  SIGNUP_TEST_PASSWORD,
} from "../test-support/signup-harness.ts";

async function invited() {
  const h = await createSignUpHarness({ mail: false });
  const workspaces = createWorkspacesRepository(h.db);
  const workspace = await workspaces.create({
    name: "Acme",
    slug: "acme",
    createdBy: null,
  });
  const admin = await h.user(h.admin.email);
  if (admin === undefined) throw new Error("the instance has no admin");
  await workspaces.addMember(workspace.id, admin.id, "owner");
  const tokens: string[] = [];
  const assembled = assembleWorkspaces({
    db: h.db,
    mail: h.mail,
    baseUrl: "https://reviews.example.test",
    githubConfigured: () => false,
    now: h.now,
    newToken: () => {
      const token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64url");
      tokens.push(token);
      return token;
    },
  });
  const made = await assembled.invitations.create({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    actorId: admin.id,
    inviterName: "Admin",
    email: "newcomer@example.com",
    role: "admin",
  });
  if (!made.ok) throw new Error(`the invitation was refused: ${made.error}`);
  return { h, workspace, assembled, token: tokens[0] ?? "" };
}

describe("an invitation and the sign-up rule", () => {
  // #101-WM-22
  it("does not let the invited person create an account once the rule has been tightened to exclude them", async () => {
    const { h } = await invited();
    await h.settings.set(
      "sign_up_rule",
      { kind: "emails", entries: ["somebody-else@example.com"] },
      null,
    );
    // The rule names addresses and nothing can verify them: the sign-up is closed.
    h.mail.configured = true;

    const response = await h.signUp({
      email: "newcomer@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await h.flush();

    // The answer is the same for every address (it says nothing about the rule), and no account exists.
    expect(response.status).toBe(200);
    expect(await h.user("newcomer@example.com")).toBeUndefined();
    expect(h.mail.to("newcomer@example.com").length).toBe(0);
  });

  // #101-WM-20
  it("lets the invited person sign up with the invited address and accept with the link, without a mail server", async () => {
    const { h, workspace, assembled, token } = await invited();

    const signedUp = await h.signUp({
      email: "newcomer@example.com",
      password: SIGNUP_TEST_PASSWORD,
    });
    await h.flush();
    const account = await h.user("newcomer@example.com");
    if (account === undefined) throw new Error("no account was made");
    const accepted = await assembled.invitations.accept(
      { token },
      {
        id: account.id,
        email: account.email,
        emailVerified: account.email_verified === 1,
        isInstanceAdmin: false,
      },
    );

    expect(signedUp.status).toBe(200);
    expect(accepted).toMatchObject({ ok: true, role: "admin" });
    expect(
      (
        await createWorkspacesRepository(h.db).findMembership(
          account.id,
          workspace.slug,
        )
      )?.role,
    ).toBe("admin");
  });
});
