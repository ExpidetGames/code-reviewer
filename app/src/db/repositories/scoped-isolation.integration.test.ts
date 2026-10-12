// SPDX-License-Identifier: Apache-2.0

// A second workspace with its own data is invisible to the first through every scoped repository
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.7). Table driven over the methods of
// every scoped repository: each is called with the scope of workspace A against the ids and keys of
// workspace B, and nothing of B may come back or change. The table must cover every method of every
// repository, so a method added later without a row here fails the last test.
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import { createAppSettingsRepository } from "./app-settings-repository.ts";
import { createInstallationLinkRequestsRepository } from "./installation-link-requests-repository.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createInvitationsRepository } from "./invitations-repository.ts";
import { createWorkspaceMembersRepository } from "./workspace-members-repository.ts";
import { createWorkspaceSecretsRepository } from "./workspace-secrets-repository.ts";
import { createJobsRepository } from "./jobs-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import { createRunsRepository } from "./runs-repository.ts";

const SHA = "b".repeat(40);

function reposOf(db: Kysely<Database>, workspaceId: string) {
  return {
    integrations: createIntegrationsRepository(db, workspaceId),
    repositories: createRepositoriesRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    appSettings: createAppSettingsRepository(db, workspaceId),
    jobs: createJobsRepository(db, workspaceId),
    runs: createRunsRepository(db, workspaceId),
    members: createWorkspaceMembersRepository(db, workspaceId),
    invitations: createInvitationsRepository(db, workspaceId),
    linkRequests: createInstallationLinkRequestsRepository(db, workspaceId),
    workspaceSecrets: createWorkspaceSecretsRepository(db, workspaceId),
  };
}
type Repos = ReturnType<typeof reposOf>;

/** One workspace with an integration, a repository, a project, a job and a setting. */
async function seed(db: Kysely<Database>, workspaceId: string, tag: string) {
  const repos = reposOf(db, workspaceId);
  const integration = await repos.integrations.create({
    type: "github_app",
    displayName: `acme-${tag}`,
    externalId: `ext-${tag}`,
    config: {},
  });
  await repos.repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `repo-${tag}`,
      fullName: `acme/${tag}`,
      url: `https://github.test/acme/${tag}`,
    },
  ]);
  const [repository] = await repos.repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  await repos.projects.activate(repository.id);
  const enqueued = await repos.jobs.enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: `https://github.test/acme/${tag}/pull/7`,
    headSha: SHA,
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: `delivery-${tag}`,
    commentId: null,
    runAfter: null,
  });
  if (enqueued.status !== "created") throw new Error("seeding failed");
  await repos.appSettings.set("review_defaults", { from: tag }, tag);
  // A member and an open invitation.
  await db
    .insertInto("users")
    .values({
      id: `user-${tag}`,
      name: `user-${tag}`,
      email: `user-${tag}@example.test`,
      email_verified: 1,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-12T00:00:00.000Z",
      updated_at: "2026-10-12T00:00:00.000Z",
    })
    .execute();
  await repos.members.add(`user-${tag}`, "owner");
  const invitation = await repos.invitations.create({
    id: `invitation-${tag}`,
    email: `invited-${tag}@example.test`,
    role: "member",
    invitedBy: `user-${tag}`,
    tokenHash: `hash-${tag}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const linkRequest = await repos.linkRequests.createPending({
    requestedBy: `user-${tag}`,
    requesterGithubLogin: `login-${tag}`,
    installationId: `installation-${tag}`,
    accountLogin: `acme-${tag}`,
    accountType: "Organization",
    accountId: `account-${tag}`,
    evidence: {
      tokenCanAccess: true,
      roleResult: "unreadable",
      roleDetail: "forbidden",
    },
  });
  await repos.workspaceSecrets.put({
    name: "llm_api_key",
    binding: `binding-${tag}`,
    ciphertext: `ciphertext-${tag}`,
    nonce: `nonce-${tag}`,
    keyVersion: 1,
    lastFour: null,
    updatedBy: `user-${tag}`,
  });
  return {
    workspaceId,
    userId: `user-${tag}`,
    invitation,
    linkRequest,
    integration,
    repository,
    job: enqueued.job,
    externalRepositoryId: `repo-${tag}`,
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Every row of every scoped table that belongs to a workspace, as stored. */
async function rowsOf(db: Kysely<Database>, workspaceId: string) {
  return {
    integrations: await db
      .selectFrom("integrations")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    repositories: await db
      .selectFrom("repositories")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    jobs: await db
      .selectFrom("jobs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    members: await db
      .selectFrom("workspace_members")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("user_id")
      .execute(),
    invitations: await db
      .selectFrom("invitations")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    linkRequests: await db
      .selectFrom("installation_link_requests")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    workspaceSecrets: await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("name")
      .execute(),
    appSettings: await db
      .selectFrom("app_settings")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("key")
      .execute(),
    projects: await db
      .selectFrom("projects")
      .innerJoin("repositories", "repositories.id", "projects.repository_id")
      .selectAll("projects")
      .where("repositories.workspace_id", "=", workspaceId)
      .orderBy("projects.id")
      .execute(),
  };
}

type Case = {
  /** `repository.method`, which the completeness test compares with the repositories themselves. */
  name: string;
  /** What the call answers when workspace A asks for what belongs to B. */
  run: (a: Repos, b: Seeded) => Promise<unknown>;
  /** Checks the answer: it is "not found" in the way that method says so, or holds only A's data. */
  expectAnswer: (answer: unknown, a: Seeded, b: Seeded) => void;
};

const notFound = (code: string) => (answer: unknown) =>
  expect(answer).toMatchObject({ rejected: expect.objectContaining({ code }) });

/** Turns a rejection into a value, so one table row can expect either. */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return { rejected: error };
  }
}

const CASES: Case[] = [
  // integrations
  {
    name: "integrations.get",
    run: (a, b) => a.integrations.get(b.integration.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "integrations.findByExternalId",
    run: (a, b) =>
      a.integrations.findByExternalId("github_app", b.integration.externalId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "integrations.list",
    run: (a) => a.integrations.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({
          id: a.integration.id,
          workspaceId: a.workspaceId,
        }),
      ]),
  },
  {
    name: "integrations.create",
    run: (a) =>
      a.integrations.create({
        type: "github_app",
        displayName: "new",
        externalId: "ext-new",
        config: {},
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({ workspaceId: a.workspaceId }),
  },
  {
    name: "integrations.setStatus",
    run: (a, b) =>
      settle(() => a.integrations.setStatus(b.integration.id, "disabled")),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  {
    name: "integrations.updateDetails",
    run: (a, b) =>
      settle(() =>
        a.integrations.updateDetails(b.integration.id, {
          displayName: "hijacked",
          config: {},
        }),
      ),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  // repositories
  {
    name: "repositories.list",
    run: (a) => a.repositories.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.repository.id }),
      ]),
  },
  {
    name: "repositories.list (filtered by the integration of B)",
    run: (a, b) => a.repositories.list({ integrationId: b.integration.id }),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "repositories.get",
    run: (a, b) => a.repositories.get(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "repositories.findByExternalId",
    run: (a, b) =>
      a.repositories.findByExternalId(b.integration.id, b.externalRepositoryId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "repositories.reconcile",
    run: (a, b) => settle(() => a.repositories.reconcile(b.integration.id, [])),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  {
    name: "repositories.deactivateAll",
    run: (a, b) => a.repositories.deactivateAll(b.integration.id),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  // projects
  {
    name: "projects.get",
    run: (a, b) => a.projects.get(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.findActiveForRepository",
    run: (a, b) => a.projects.findActiveForRepository(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.findActiveForExternalRepository",
    run: (a, b) =>
      a.projects.findActiveForExternalRepository(
        b.integration.id,
        b.externalRepositoryId,
      ),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.activate",
    run: (a, b) => a.projects.activate(b.repository.id),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ kind: "repository_not_found" }),
  },
  {
    name: "projects.deactivate",
    run: (a, b) => a.projects.deactivate(b.repository.id),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ kind: "repository_not_found" }),
  },
  {
    name: "projects.updateSettings",
    run: (a, b) =>
      a.projects.updateSettings(b.repository.id, { hijacked: true }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.list",
    run: (a) => a.projects.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({
          repository: expect.objectContaining({ id: a.repository.id }),
        }),
      ]),
  },
  {
    name: "projects.find",
    run: (a, b) => a.projects.find(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // app settings
  {
    name: "appSettings.get",
    run: (a) => a.appSettings.get("review_defaults"),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        value: { from: a.integration.displayName.replace("acme-", "") },
      }),
  },
  {
    name: "appSettings.set",
    run: (a) =>
      a.appSettings.set("review_defaults", { from: "A-changed" }, "a"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "appSettings.delete",
    run: (a) => a.appSettings.delete("review_defaults"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // jobs
  {
    name: "jobs.get",
    run: (a, b) => a.jobs.get(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobs.list",
    run: (a) => a.jobs.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([expect.objectContaining({ id: a.job.id })]),
  },
  {
    name: "jobs.list (filtered by the repository of B)",
    run: (a, b) => a.jobs.list({ repositoryId: b.repository.id }),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "jobs.enqueue",
    run: (a, b) =>
      settle(() =>
        a.jobs.enqueue({
          repositoryId: b.repository.id,
          prNumber: 99,
          prUrl: "https://github.test/acme/b/pull/99",
          headSha: SHA,
          command: "review",
          args: "",
          triggerKind: "manual",
          actorLogin: "octocat",
          deliveryId: null,
          commentId: null,
          runAfter: null,
        }),
      ),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        rejected: expect.objectContaining({
          code: "SQLITE_CONSTRAINT_FOREIGNKEY",
        }),
      }),
  },
  {
    name: "jobs.cancelWaitingForRepository",
    run: (a, b) => a.jobs.cancelWaitingForRepository(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "jobs.discardWaitingForPr",
    run: (a, b) => a.jobs.discardWaitingForPr(b.repository.id, 7),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "jobs.discardWaitingAutomaticForPr",
    run: (a, b) => a.jobs.discardWaitingAutomaticForPr(b.repository.id, 7),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  // members
  {
    name: "members.list",
    run: (a) => a.members.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([expect.objectContaining({ userId: a.userId })]),
  },
  {
    name: "members.get",
    run: (a, b) => a.members.get(b.userId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "members.countOwners",
    run: (a) => a.members.countOwners(),
    expectAnswer: (answer) => expect(answer).toBe(1),
  },
  {
    name: "members.add",
    run: (a, b) => a.members.add(b.userId, "admin"),
    // B's owner joins A: a row of A's own; B keeps its row (the check below compares B's rows).
    expectAnswer: (answer) => expect(answer).toBe("added"),
  },
  {
    name: "members.setRole",
    run: (a, b) => a.members.setRole(b.userId, "member"),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "members.remove",
    run: (a, b) => a.members.remove(b.userId),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "members.lock",
    run: (a) => a.members.lock(),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // invitations
  {
    name: "invitations.create",
    run: (a) =>
      a.invitations.create({
        id: "invitation-new",
        email: "new@example.test",
        role: "member",
        invitedBy: "user-a",
        tokenHash: "hash-new",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({ workspaceId: a.workspaceId }),
  },
  {
    name: "invitations.get",
    run: (a, b) => a.invitations.get(b.invitation.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "invitations.listOpen",
    run: (a) => a.invitations.listOpen(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.invitation.id }),
      ]),
  },
  {
    name: "invitations.findOpenByEmail",
    run: (a, b) => a.invitations.findOpenByEmail(b.invitation.email),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "invitations.revokeExpiredFor",
    run: (a, b) => a.invitations.revokeExpiredFor(b.invitation.email),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "invitations.revoke",
    run: (a, b) => a.invitations.revoke(b.invitation.id),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "invitations.replaceToken",
    run: (a, b) =>
      a.invitations.replaceToken(
        b.invitation.id,
        "hash-hijacked",
        new Date("2099-01-01T00:00:00.000Z"),
      ),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "invitations.markAccepted",
    run: (a, b) => a.invitations.markAccepted(b.invitation.id, "user-a"),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  // installation link requests
  {
    name: "linkRequests.createPending",
    run: (a, b) =>
      a.linkRequests.createPending({
        requestedBy: "user-a",
        requesterGithubLogin: "login-a",
        // The same installation as B's pending request: A's request is A's own, B's is not touched.
        installationId: b.linkRequest.installationId,
        accountLogin: "acme-b",
        accountType: "Organization",
        accountId: "account-b",
        evidence: {
          tokenCanAccess: false,
          roleResult: "unreadable",
          roleDetail: "forbidden",
        },
      }),
    expectAnswer: (answer, a, b) =>
      expect(answer).toMatchObject({
        workspaceId: a.workspaceId,
        id: expect.not.stringMatching(b.linkRequest.id),
      }),
  },
  {
    name: "linkRequests.get",
    run: (a, b) => a.linkRequests.get(b.linkRequest.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "linkRequests.findPending",
    run: (a, b) => a.linkRequests.findPending(b.linkRequest.installationId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "linkRequests.list",
    run: (a) => a.linkRequests.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.linkRequest.id }),
      ]),
  },
  {
    name: "linkRequests.withdrawPending",
    run: (a, b) => a.linkRequests.withdrawPending(b.linkRequest.installationId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // workspace secrets: the names are the same in every workspace, so the scope is what decides whose it is
  {
    name: "workspaceSecrets.get",
    run: (a) => a.workspaceSecrets.get("llm_api_key"),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ binding: "binding-a" }),
  },
  {
    name: "workspaceSecrets.put",
    run: (a) =>
      a.workspaceSecrets.put({
        name: "llm_api_key",
        binding: "binding-a-changed",
        ciphertext: "ciphertext-a-changed",
        nonce: "nonce-a-changed",
        keyVersion: 1,
        lastFour: null,
        updatedBy: null,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "workspaceSecrets.remove",
    run: (a) => a.workspaceSecrets.remove("llm_api_key"),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  // runs
  {
    name: "runs.list",
    run: (a) => a.runs.list({ limit: 50 }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        runs: [{ job: expect.objectContaining({ id: a.job.id }) }],
        hasMore: false,
      }),
  },
  {
    name: "runs.get",
    run: (a, b) => a.runs.get(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "runs.latestPerRepository",
    run: (a, b) => a.runs.latestPerRepository([b.repository.id]),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
];

async function twoWorkspaces() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const a = await seed(db, idA, "a");
  const b = await seed(db, idB, "b");
  return { db, a, b, reposA: reposOf(db, idA), reposB: reposOf(db, idB) };
}

describe("enqueueing under the scope of A against what B already has", () => {
  /**
   * B has a waiting automatic job (its run-after time is in the future, like a debounced push) and
   * a job that answers a comment. Every lookup that decides "this job exists already" must stay
   * inside the workspace: if one looks across workspaces, A is handed B's job (or B's job is changed)
   * instead of being refused.
   */
  async function withBusyB() {
    const base = await twoWorkspaces();
    const future = "2099-01-01T00:00:00.000Z";
    await base.db
      .updateTable("jobs")
      .set({ run_after: future })
      .where("id", "=", base.b.job.id)
      .execute();
    const commentJob = await base.reposB.jobs.enqueue({
      repositoryId: base.b.repository.id,
      prNumber: 8,
      prUrl: "https://github.test/acme/b/pull/8",
      headSha: SHA,
      command: "review",
      args: "",
      triggerKind: "comment",
      actorLogin: "octocat",
      deliveryId: "delivery-comment-b",
      commentId: "comment-b",
      runAfter: null,
    });
    if (commentJob.status !== "created") throw new Error("seeding failed");
    return { ...base, commentJob: commentJob.job };
  }

  const input = (repositoryId: string) => ({
    repositoryId,
    prNumber: 7,
    prUrl: "https://github.test/acme/b/pull/7",
    headSha: SHA,
    command: "review" as const,
    args: "",
    triggerKind: "manual" as const,
    actorLogin: "mallory",
    deliveryId: null,
    commentId: null,
    runAfter: null,
  });

  // DM-06, DM-07
  it("is refused for the same pull request and command as a job of B, and B's job keeps its run-after time", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    // A person's job would be "already active" and pull B's waiting job forward.
    await expect(
      reposA.jobs.enqueue(input(b.repository.id)),
    ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("is refused for the same head commit as an automatic job of B, which it would otherwise return", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    await expect(
      reposA.jobs.enqueue({
        ...input(b.repository.id),
        triggerKind: "webhook",
        actorLogin: "octocat",
      }),
      // The unique index of automatic jobs per head commit may refuse it before the foreign key does.
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^SQLITE_CONSTRAINT_(FOREIGNKEY|UNIQUE)$/),
    });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("does not return the job of B for the delivery id of B", async () => {
    const { db, a, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    // A valid job in A's own repository that only reuses B's delivery id: the answer must not be
    // B's job. (The unique index on delivery ids is instance wide, so the insert is refused.)
    await expect(
      reposA.jobs.enqueue({
        ...input(a.repository.id),
        prNumber: 55,
        deliveryId: "delivery-b",
      }),
    ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("does not return the job of B for the comment of B", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    await expect(
      reposA.jobs.enqueue({
        ...input(b.repository.id),
        prNumber: 8,
        triggerKind: "comment",
        commentId: "comment-b",
      }),
    ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
    expect(
      await db
        .selectFrom("job_comments")
        .select("job_id")
        .where("comment_id", "=", "comment-b")
        .execute(),
    ).toEqual([{ job_id: expect.any(String) }]);
  });
});

describe("two workspaces", () => {
  // DM-06, DM-07
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "keep workspace B out of reach of %s under the scope of A",
    async (_name, testCase) => {
      const { db, a, b, reposA } = await twoWorkspaces();
      const before = await rowsOf(db, b.workspaceId);

      const answer = await testCase.run(reposA, b);

      testCase.expectAnswer(answer, a, b);
      expect(await rowsOf(db, b.workspaceId)).toEqual(before);
    },
  );

  // DM-06
  it("have a table row for every method of every scoped repository", async () => {
    const { reposA } = await twoWorkspaces();
    const covered = new Set(
      CASES.map((testCase) => testCase.name.split(" ")[0] ?? ""),
    );
    const methods = Object.entries(reposA).flatMap(([group, repository]) =>
      Object.keys(repository).map((method) => `${group}.${method}`),
    );

    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods)
      expect(covered, `${method} has no case in CASES`).toContain(method);
  });

  // DM-10
  it("keep the review defaults apart: changing A leaves B with its own", async () => {
    const { reposA, reposB } = await twoWorkspaces();

    await reposA.appSettings.set("review_defaults", { changed: true }, "alice");

    expect((await reposA.appSettings.get("review_defaults"))?.value).toEqual({
      changed: true,
    });
    expect((await reposB.appSettings.get("review_defaults"))?.value).toEqual({
      from: "b",
    });
  });

  // DM-10
  it("give a workspace that never saved defaults none, so the built-in values apply", async () => {
    const { db } = await twoWorkspaces();
    const third = reposOf(db, await addWorkspace(db, "third"));

    expect(await third.appSettings.get("review_defaults")).toBeUndefined();
  });

  it("can hold the same pull request number in both, each with its own job", async () => {
    const { a, b, reposA, reposB } = await twoWorkspaces();

    expect(await reposA.jobs.list()).toEqual([
      expect.objectContaining({ id: a.job.id, workspaceId: a.workspaceId }),
    ]);
    expect(await reposB.jobs.list()).toEqual([
      expect.objectContaining({ id: b.job.id, workspaceId: b.workspaceId }),
    ]);
  });
});
