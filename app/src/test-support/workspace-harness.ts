// SPDX-License-Identifier: Apache-2.0

// The workspaces assembled for integration tests: a real SQLite file with users, one workspace and its
// members, the real services (members, invitations) with the real counters, a mail double that can be
// switched between "mail server" and "none", and a clock the test moves by hand. No Better Auth and no
// HTTP here; the services decide for themselves who may do what, which is what these tests pin down.
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import {
  createInstanceSettingsRepository,
  type InstanceSettingValues,
} from "../db/repositories/instance-settings-repository.ts";
import {
  createWorkspacesRepository,
  type Workspace,
} from "../db/repositories/workspaces-repository.ts";
import {
  createInvitationService,
  type Acceptor,
} from "../workspaces/invitations.ts";
import { createMembersService } from "../workspaces/members.ts";
import { createWorkspaceLimits } from "../workspaces/rate-limits.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { createFakeMail } from "./fake-mail.ts";
import { createTestDatabase } from "./test-database.ts";

export const WORKSPACE_TEST_BASE_URL = "https://reviews.example.test";

export type WorkspaceHarnessOptions = {
  /** Whether the instance starts with a mail server. Default: no. */
  mail?: boolean;
  /** The sign-up rule the instance starts with. Default: everyone. */
  rule?: InstanceSettingValues["sign_up_rule"];
  tenancy?: "single" | "multi";
  /** Whether sign-in with GitHub exists. Default: no. */
  github?: boolean;
  /** Which ways to sign in are switched on. Default: nothing saved. */
  signInMethods?: InstanceSettingValues["sign_in_methods"];
};

export async function createWorkspaceHarness(
  options: WorkspaceHarnessOptions = {},
) {
  const { db, config } = await createTestDatabase();
  const clock = { time: Date.parse("2026-10-12T08:00:00.000Z") };
  const now = () => new Date(clock.time);
  const settings = createInstanceSettingsRepository(db, now);
  await settings.set("tenancy", options.tenancy ?? "multi", null);
  await settings.set(
    "sign_up_rule",
    options.rule ?? { kind: "everyone" },
    null,
  );

  if (options.signInMethods !== undefined)
    await settings.set("sign_in_methods", options.signInMethods, null);

  const mail = createFakeMail(options.mail ?? false);
  const rateLimits = createRateLimitsRepository(db, now);
  const limits = createWorkspaceLimits(rateLimits, now);
  const tokens: string[] = [];
  const logs: string[] = [];
  const invitations = createInvitationService({
    db,
    mail,
    limits,
    baseUrl: WORKSPACE_TEST_BASE_URL,
    githubConfigured: () => options.github ?? false,
    now,
    // Real tokens (256 random bits); the harness only remembers what was made.
    newToken: () => {
      const token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64url");
      tokens.push(token);
      return token;
    },
    log: (line) => logs.push(line),
  });
  const members = createMembersService({ db, now });
  const workspaces = createWorkspacesRepository(db, now);

  async function addUser(
    id: string,
    options: {
      email?: string;
      verified?: boolean;
      isInstanceAdmin?: boolean;
      name?: string;
    } = {},
  ): Promise<Acceptor & { name: string }> {
    const email = options.email ?? `${id}@example.test`;
    const name = options.name ?? id;
    await db
      .insertInto("users")
      .values({
        id,
        name,
        email,
        email_verified: options.verified === false ? 0 : 1,
        image: null,
        github_login: null,
        imported_at: null,
        is_instance_admin: options.isInstanceAdmin === true ? 1 : 0,
        org_checked_at: null,
        org_checked_for: null,
        created_at: new Date(clock.time).toISOString(),
        updated_at: new Date(clock.time).toISOString(),
      })
      .execute();
    return {
      id,
      email,
      name,
      emailVerified: options.verified !== false,
      isInstanceAdmin: options.isInstanceAdmin === true,
    };
  }

  /** A workspace, made directly (not through the limit), without members. */
  async function addWorkspace(slug: string): Promise<Workspace> {
    return workspaces.create({
      name: `Workspace ${slug}`,
      slug,
      createdBy: null,
    });
  }

  /** A user with a membership: the account is made and joins the workspace with the role. */
  async function addMember(
    workspace: Workspace,
    id: string,
    role: WorkspaceRole,
    options: Parameters<typeof addUser>[1] = {},
  ): Promise<Acceptor & { name: string }> {
    const user = await addUser(id, options);
    await workspaces.addMember(workspace.id, id, role);
    return user;
  }

  return {
    db,
    config,
    now,
    advance(ms: number) {
      clock.time += ms;
    },
    mail,
    settings,
    rateLimits,
    limits,
    invitations,
    members,
    workspaces,
    /** Every token the invitation service made, oldest first. */
    tokens,
    /** Every line the invitation service logged. */
    logs,
    addUser,
    addWorkspace,
    addMember,
    /** The role a user has in a workspace, straight from the table. */
    async roleOf(
      workspaceId: string,
      userId: string,
    ): Promise<WorkspaceRole | undefined> {
      const row = await db
        .selectFrom("workspace_members")
        .select("role")
        .where("workspace_id", "=", workspaceId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row?.role as WorkspaceRole | undefined;
    },
    async invitationRows(workspaceId: string) {
      return db
        .selectFrom("invitations")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at")
        .execute();
    },
  };
}

export type WorkspaceHarness = Awaited<
  ReturnType<typeof createWorkspaceHarness>
>;
