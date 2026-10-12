// SPDX-License-Identifier: Apache-2.0

// The import of an existing installation (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11): a
// database made by the release before accounts (legacy-installation.ts, migrated to the current schema the way the
// server does it on its first start) and the environment of that release go through the same code the server
// runs at start (`importOnStart`), with the fake GitHub standing in for github.com. What is checked is what ends
// up in the database, what is logged, and that a failure leaves nothing behind.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGithubCredentialStore } from "../github-config/credentials.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { openDatabase } from "../db/connection.ts";
import { migrateToLatest } from "../db/migrate.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { readSetupState } from "../setup/state.ts";
import {
  TEST_APP_SLUG,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
} from "../test-support/github-app.ts";
import {
  startTestGithub,
  TEST_CLIENT_ID,
} from "../test-support/github-fake.ts";
import {
  createLegacyInstallation,
  type LegacySeed,
  type LegacyUserSeed,
} from "../test-support/legacy-installation.ts";
import { createTestDirectory, track } from "../test-support/test-database.ts";
import { importOnStart } from "./startup.ts";
import type { ImportStep } from "./import.ts";

const SECRET = "legacy-secret-0123456789-0123456789-abcdef";
const LLM_KEY = "sk-or-legacy-llm-key-0123456789abcdef";
const URL_OF_THE_APP = "http://localhost:3000";

const USERS: LegacyUserSeed[] = [
  { login: "alice", githubId: 1001, createdAt: "2026-09-01T10:00:00.000Z" },
  { login: "bob", githubId: 1002, createdAt: "2026-09-02T10:00:00.000Z" },
  { login: "carol", githubId: 1003, createdAt: "2026-09-03T10:00:00.000Z" },
];

type Harness = Awaited<ReturnType<typeof installation>>;

async function installation(
  seed: Partial<LegacySeed> = {},
  options: { github?: Awaited<ReturnType<typeof startTestGithub>> } = {},
) {
  const github = options.github ?? (await startTestGithub());
  const directory = await createTestDirectory();
  const path = join(directory, "app.db");
  await createLegacyInstallation(path, {
    secret: SECRET,
    users: USERS,
    installations: [
      {
        id: 5001,
        accountLogin: "acme",
        accountId: 77,
        repositories: [
          { id: 9001, fullName: "acme/widgets", project: true },
          { id: 9002, fullName: "acme/gadgets" },
        ],
      },
    ],
    ...seed,
  });
  // The first start of the new version: the migrations, then the import.
  const db = track(openDatabase({ path, busyTimeoutMs: 5000 }));
  await migrateToLatest(db);
  const lines: string[] = [];
  const exits: number[] = [];
  const log = {
    info: (line: string) => void lines.push(line),
    warn: (line: string) => void lines.push(line),
    error: (line: string) => void lines.push(line),
  };
  const env = (overrides: Record<string, string | undefined> = {}) => ({
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: URL_OF_THE_APP,
    GITHUB_API_BASE_URL: github.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    GITHUB_APP_ID: "424242",
    GITHUB_APP_SLUG: TEST_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: testAppKeys().privateKey,
    GITHUB_APP_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    GITHUB_OAUTH_CLIENT_ID: "old-oauth-client",
    GITHUB_OAUTH_CLIENT_SECRET: "old-oauth-client-secret-value",
    LLM_PROVIDER: "openrouter",
    LLM_API_KEY: LLM_KEY,
    ALLOWED_GITHUB_LOGINS: "alice,bob,carol",
    ...overrides,
  });
  const run = (
    environment: Record<string, string | undefined> = env(),
    afterStep?: (step: ImportStep) => void,
  ) =>
    importOnStart({
      db,
      env: environment,
      log,
      exit: (code) => void exits.push(code),
      ...(afterStep === undefined ? {} : { overrides: { afterStep } }),
    });
  return { db, path, directory, github, lines, exits, env, run };
}

async function memberships(h: Harness): Promise<Array<[string, string]>> {
  const rows = await h.db
    .selectFrom("workspace_members")
    .innerJoin("users", "users.id", "workspace_members.user_id")
    .select(["users.github_login as login", "workspace_members.role as role"])
    .orderBy("users.created_at")
    .execute();
  return rows.map((row) => [row.login ?? "", row.role]);
}

async function settingOf<
  K extends
    | "import_notice"
    | "import_state"
    | "sign_in_methods"
    | "sign_up_rule"
    | "github_app",
>(h: Harness, key: K) {
  return createInstanceSettingsRepository(h.db).get(key);
}

describe("importing an existing installation", () => {
  // #106-IM-01
  it("puts the data, the GitHub App and the LLM key into the new model and leaves the instance not set up", async () => {
    const h = await installation();

    const outcome = await h.run();

    expect(outcome?.kind).toBe("imported");
    const workspaces = await h.db
      .selectFrom("workspaces")
      .selectAll()
      .execute();
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    for (const table of [
      "integrations",
      "repositories",
      "jobs",
      "app_settings",
    ] as const) {
      const rows = await h.db
        .selectFrom(table)
        .select("workspace_id")
        .execute();
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows)
        expect(row.workspace_id, table).toBe(workspace?.id);
    }
    // The GitHub App is in the encrypted store and read from there, with no variable in sight.
    const credentials = createGithubCredentialStore({
      db: h.db,
      appSecret: SECRET,
      env: {},
    });
    const github = await credentials.load();
    expect(github.source).toBe("database");
    expect(github.stored).toMatchObject({
      appId: "424242",
      slug: TEST_APP_SLUG,
      clientId: null,
      privateApp: null,
      origin: "import",
    });
    expect(github.app.ok && github.app.config.webhookSecret).toBe(
      TEST_WEBHOOK_SECRET,
    );
    expect(github.app.ok && github.app.config.privateKey).toContain(
      "BEGIN RSA PRIVATE KEY",
    );
    // The LLM key is the default workspace's key.
    const llm = createWorkspaceLlm({
      db: h.db,
      appSecret: () => SECRET,
      env: () => ({}),
    });
    const revealed = await llm.keyServiceFor(workspace?.id ?? "").reveal();
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(LLM_KEY);
    // Not set up yet: the short setup follows, and the sign in with GitHub waits for the admin.
    expect(await settingOf(h, "import_state")).toBe("done");
    expect(await settingOf(h, "sign_in_methods")).toEqual({
      emailPassword: true,
      github: false,
    });
    expect((await readSetupState(h.db)).kind).toBe("existing");
    expect(
      (await h.db.selectFrom("users").select("imported_at").execute()).every(
        (u) => u.imported_at !== null,
      ),
    ).toBe(true);
    // The secrets are not in the rows in the clear.
    const stored = JSON.stringify([
      await h.db.selectFrom("secrets").selectAll().execute(),
      await h.db.selectFrom("workspace_secrets").selectAll().execute(),
    ]);
    for (const value of [LLM_KEY, TEST_WEBHOOK_SECRET, "BEGIN RSA PRIVATE KEY"])
      expect(stored).not.toContain(value);
  });

  // #106-IM-03
  it("makes the users of the allow list members and the earliest created of them the Owner", async () => {
    const h = await installation({
      users: [
        {
          login: "carol",
          githubId: 1003,
          createdAt: "2026-09-03T10:00:00.000Z",
        },
        {
          login: "alice",
          githubId: 1001,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
        { login: "bob", githubId: 1002, createdAt: "2026-09-02T10:00:00.000Z" },
      ],
      pins: [
        { login: "alice", githubId: 1001 },
        { login: "bob", githubId: 1002 },
        { login: "carol", githubId: 1003 },
      ],
    });

    await h.run();

    expect(await memberships(h)).toEqual([
      ["alice", "owner"],
      ["bob", "member"],
      ["carol", "member"],
    ]);
  });

  // #106-IM-04
  it("does not make users members who are off the list or whose login is bound to another GitHub account, and lists both", async () => {
    const h = await installation({
      users: [
        {
          login: "alice",
          githubId: 1001,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
        {
          login: "dave",
          githubId: 1004,
          createdAt: "2026-09-02T10:00:00.000Z",
        },
        {
          login: "erin",
          githubId: 1005,
          createdAt: "2026-09-03T10:00:00.000Z",
        },
      ],
      // erin is on the list, but the login is bound to another account id.
      pins: [{ login: "erin", githubId: 9999 }],
    });

    await h.run(h.env({ ALLOWED_GITHUB_LOGINS: "alice,erin" }));

    expect(await memberships(h)).toEqual([["alice", "owner"]]);
    const notice = await settingOf(h, "import_notice");
    expect(notice?.notMembers).toEqual([
      { login: "dave", reason: "not_allowed" },
      { login: "erin", reason: "login_bound_to_another_account" },
    ]);
  });

  // #106-IM-04
  it("binds an unbound listed login to the account that has it first and admits no other", async () => {
    const h = await installation({
      users: [
        {
          login: "alice",
          githubId: 1001,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
        // GitHub gave the name to somebody else after a rename.
        {
          login: "alice",
          githubId: 2002,
          createdAt: "2026-09-05T10:00:00.000Z",
          email: "other@example.test",
        },
      ],
    });

    await h.run(h.env({ ALLOWED_GITHUB_LOGINS: "alice" }));

    const rows = await h.db
      .selectFrom("workspace_members")
      .innerJoin("accounts", "accounts.user_id", "workspace_members.user_id")
      .select("accounts.account_id as id")
      .execute();
    expect(rows.map((row) => row.id)).toEqual(["1001"]);
  });

  // #106-IM-04
  it("takes an id given in the list as login:id over the stored binding", async () => {
    const h = await installation({
      users: [
        { login: "alice", githubId: 1001 },
        { login: "bob", githubId: 1002 },
      ],
      pins: [{ login: "alice", githubId: 1001 }],
    });

    // The list says alice is account 4444: neither of the two is.
    await h.run(h.env({ ALLOWED_GITHUB_LOGINS: "alice:4444,bob" }));

    expect(await memberships(h)).toEqual([["bob", "owner"]]);
  });

  // #106-IM-05
  it("admits the members of the allowed organization after a live check with their own token", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addUser({ id: 1002, login: "bob", name: null, email: null });
    github.addOrgMember("acme", "alice");
    const h = await installation(
      {
        users: [
          {
            login: "alice",
            githubId: 1001,
            token: github.issueAccessToken("alice", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
          {
            login: "bob",
            githubId: 1002,
            token: github.issueAccessToken("bob", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
        ],
      },
      { github },
    );

    await h.run(
      h.env({ ALLOWED_GITHUB_LOGINS: undefined, ALLOWED_GITHUB_ORG: "acme" }),
    );

    expect(await memberships(h)).toEqual([["alice", "owner"]]);
    expect((await settingOf(h, "import_notice"))?.notMembers).toEqual([
      { login: "bob", reason: "not_allowed" },
    ]);
  });

  // #106-IM-05
  it("lets either rule admit a user when a list and an organization are both set", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addUser({ id: 1002, login: "bob", name: null, email: null });
    github.addOrgMember("acme", "bob");
    const h = await installation(
      {
        users: [
          {
            login: "alice",
            githubId: 1001,
            token: github.issueAccessToken("alice", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
          {
            login: "bob",
            githubId: 1002,
            token: github.issueAccessToken("bob", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
        ],
      },
      { github },
    );

    await h.run(
      h.env({ ALLOWED_GITHUB_LOGINS: "alice", ALLOWED_GITHUB_ORG: "acme" }),
    );

    expect(await memberships(h)).toEqual([
      ["alice", "owner"],
      ["bob", "member"],
    ]);
  });

  // #106-IM-06
  it("treats a user whose organization check cannot be completed as blocked and leaves the others alone", async () => {
    const github = await startTestGithub();
    for (const [id, login] of [
      [1001, "alice"],
      [1002, "bob"],
      [1003, "carol"],
      [1004, "dave"],
    ] as const) {
      github.addUser({ id, login, name: null, email: null });
      github.addOrgMember("acme", login);
    }
    const token = (login: string) =>
      github.issueAccessToken(login, {
        scope: "read:org",
        clientId: TEST_CLIENT_ID,
      });
    const h = await installation(
      {
        users: [
          // A token stored with another secret cannot be decrypted.
          {
            login: "alice",
            githubId: 1001,
            token: token("alice"),
            tokenFromAnotherSecret: true,
          },
          // No token at all.
          { login: "bob", githubId: 1002, token: null },
          // A token GitHub does not know any more.
          { login: "carol", githubId: 1003, token: "gho_revoked" },
          { login: "dave", githubId: 1004, token: token("dave") },
        ],
      },
      { github },
    );

    await h.run(
      h.env({ ALLOWED_GITHUB_LOGINS: undefined, ALLOWED_GITHUB_ORG: "acme" }),
    );

    expect(await memberships(h)).toEqual([["dave", "owner"]]);
    expect((await settingOf(h, "import_notice"))?.notMembers).toEqual([
      { login: "alice", reason: "check_failed" },
      { login: "bob", reason: "check_failed" },
      { login: "carol", reason: "check_failed" },
    ]);
  });

  // #106-IM-06
  it("treats everyone as blocked while GitHub cannot be reached, and the import still finishes", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addOrgMember("acme", "alice");
    const h = await installation(
      {
        users: [
          {
            login: "alice",
            githubId: 1001,
            token: github.issueAccessToken("alice", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
        ],
      },
      { github },
    );
    github.failMembershipEndpoint({ kind: "status", status: 503 });

    await h.run(
      h.env({ ALLOWED_GITHUB_LOGINS: undefined, ALLOWED_GITHUB_ORG: "acme" }),
    );

    expect(await memberships(h)).toEqual([]);
    expect(await settingOf(h, "import_state")).toBe("done");
    expect((await settingOf(h, "import_notice"))?.notMembers).toEqual([
      { login: "alice", reason: "check_failed" },
    ]);
  });

  // #106-IM-07
  it("lists the allowed logins that never signed in and says the organization is not migrated, without deriving a sign-up rule", async () => {
    const h = await installation({
      users: [{ login: "alice", githubId: 1001 }],
    });

    await h.run(
      h.env({
        ALLOWED_GITHUB_LOGINS: "alice,Frank,gina",
        ALLOWED_GITHUB_ORG: "acme",
      }),
    );

    const notice = await settingOf(h, "import_notice");
    expect(notice?.neverSignedIn).toEqual(["frank", "gina"]);
    expect(notice?.organization).toBe("acme");
    expect(await settingOf(h, "sign_up_rule")).toBeUndefined();
    const stored = JSON.stringify(
      await h.db.selectFrom("instance_settings").selectAll().execute(),
    );
    expect(stored).not.toContain('acme"');
  });

  // #106-IM-09
  it("does nothing on a later start and never overwrites what the admin changed", async () => {
    const h = await installation();
    await h.run();
    const settings = createInstanceSettingsRepository(h.db);
    await settings.set(
      "sign_in_methods",
      { emailPassword: true, github: true },
      null,
    );
    const llm = createWorkspaceLlm({
      db: h.db,
      appSecret: () => SECRET,
      env: () => ({}),
    });
    const workspace = await h.db
      .selectFrom("workspaces")
      .select("id")
      .executeTakeFirstOrThrow();
    await llm
      .keyServiceFor(workspace.id)
      .save(
        { provider: "openrouter", apiKey: "sk-or-changed-by-the-admin-0123" },
        null,
      );
    const before = JSON.stringify(
      await h.db.selectFrom("instance_settings").selectAll().execute(),
    );
    h.lines.length = 0;

    const again = await h.run(
      h.env({
        LLM_API_KEY: "sk-or-a-different-key-0123456789",
        ALLOWED_GITHUB_LOGINS: "alice",
      }),
    );

    expect(again?.kind).toBe("not_needed");
    expect(
      JSON.stringify(
        await h.db.selectFrom("instance_settings").selectAll().execute(),
      ),
    ).toBe(before);
    expect(
      await h.db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
    const revealed = await llm.keyServiceFor(workspace.id).reveal();
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(
      "sk-or-changed-by-the-admin-0123",
    );
    expect(await memberships(h)).toHaveLength(3);
  });

  // #106-IM-10, #106-IM-22
  it("changes nothing when the import fails in the middle, names the failure in one line and succeeds on the next start", async () => {
    const h = await installation();
    const countsBefore = async () => ({
      workspaces: (await h.db.selectFrom("workspaces").select("id").execute())
        .length,
      members: (
        await h.db.selectFrom("workspace_members").select("user_id").execute()
      ).length,
      settings: JSON.stringify(
        await h.db.selectFrom("instance_settings").selectAll().execute(),
      ),
      secrets: (await h.db.selectFrom("secrets").select("name").execute())
        .length,
      workspaceSecrets: (
        await h.db.selectFrom("workspace_secrets").select("name").execute()
      ).length,
      imported: (
        await h.db
          .selectFrom("users")
          .select("imported_at")
          .where("imported_at", "is not", null)
          .execute()
      ).length,
    });
    const before = await countsBefore();

    const failed = await h.run(h.env(), (step) => {
      if (step === "llm") throw new Error("The disk is full.");
    });

    expect(failed).toBeNull();
    expect(h.exits).toEqual([1]);
    expect(await countsBefore()).toEqual(before);
    expect(await settingOf(h, "import_state")).toBeUndefined();
    expect((await readSetupState(h.db)).kind).toBe("existing");
    const failure = h.lines.filter((line) => line.includes("IMPORT_FAILED"));
    expect(failure).toHaveLength(1);
    expect(failure[0]).toContain("The disk is full.");

    // The cause is fixed: the whole import runs again, from the beginning.
    h.exits.length = 0;
    const retried = await h.run();
    expect(retried?.kind).toBe("imported");
    expect(h.exits).toEqual([]);
    expect(await settingOf(h, "import_state")).toBe("done");
    expect(await memberships(h)).toHaveLength(3);

    // And once more, as a restart before the wizard has finished: nothing is imported twice.
    const state = await countsBefore();
    await h.run();
    expect(await countsBefore()).toEqual(state);
    expect(
      await h.db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  // #106-IM-10
  for (const step of [
    "workspace",
    "users",
    "members",
    "github_app",
    "sign_in_methods",
    "notice",
  ] as const)
    it(`rolls everything back when the import fails after the step ${step}`, async () => {
      const h = await installation();

      await h.run(h.env(), (reached) => {
        if (reached === step) throw new Error("injected");
      });

      expect(h.exits).toEqual([1]);
      expect(await settingOf(h, "import_state")).toBeUndefined();
      expect(await settingOf(h, "github_app")).toBeUndefined();
      expect(await settingOf(h, "sign_in_methods")).toBeUndefined();
      expect(
        await h.db.selectFrom("workspace_members").select("user_id").execute(),
      ).toEqual([]);
      expect(await h.db.selectFrom("secrets").select("name").execute()).toEqual(
        [],
      );
      expect(
        await h.db.selectFrom("workspace_secrets").select("name").execute(),
      ).toEqual([]);
      expect(
        await h.db
          .selectFrom("users")
          .select("id")
          .where("imported_at", "is not", null)
          .execute(),
      ).toEqual([]);
    });

  // #106-IM-11
  it("reads the tokens of the earlier sign in with the old name of the master key", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addOrgMember("acme", "alice");
    const h = await installation(
      {
        users: [
          {
            login: "alice",
            githubId: 1001,
            token: github.issueAccessToken("alice", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
        ],
      },
      { github },
    );

    // Only BETTER_AUTH_SECRET is set (env() has no APP_SECRET).
    await h.run(
      h.env({ ALLOWED_GITHUB_LOGINS: undefined, ALLOWED_GITHUB_ORG: "acme" }),
    );

    expect(await memberships(h)).toEqual([["alice", "owner"]]);
    // What was imported is encrypted with the same key, so the old name keeps everything readable.
    const credentials = createGithubCredentialStore({
      db: h.db,
      appSecret: SECRET,
      env: {},
    });
    expect((await credentials.load()).app.ok).toBe(true);
  });

  // #106-IM-12
  it("lists the users whose token cannot be read when APP_SECRET differs from the old BETTER_AUTH_SECRET, and does not crash", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addOrgMember("acme", "alice");
    const h = await installation(
      {
        users: [
          {
            login: "alice",
            githubId: 1001,
            token: github.issueAccessToken("alice", {
              scope: "read:org",
              clientId: TEST_CLIENT_ID,
            }),
          },
        ],
      },
      { github },
    );
    const newSecret = "a-completely-new-app-secret-0123456789-xyz";

    const outcome = await h.run(
      h.env({
        APP_SECRET: newSecret,
        ALLOWED_GITHUB_LOGINS: undefined,
        ALLOWED_GITHUB_ORG: "acme",
      }),
    );

    expect(outcome?.kind).toBe("imported");
    expect(await memberships(h)).toEqual([]);
    expect((await settingOf(h, "import_notice"))?.notMembers).toEqual([
      { login: "alice", reason: "check_failed" },
    ]);
    // The credentials are stored with the secret the server runs with.
    const credentials = createGithubCredentialStore({
      db: h.db,
      appSecret: newSecret,
      env: {},
    });
    expect((await credentials.load()).app.ok).toBe(true);
  });

  // #106-IM-13
  it("imports everything else when the environment holds no GitHub App, and GitHub is not configured", async () => {
    const h = await installation();

    await h.run(
      h.env({
        GITHUB_APP_ID: undefined,
        GITHUB_APP_SLUG: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_WEBHOOK_SECRET: undefined,
      }),
    );

    expect(await memberships(h)).toHaveLength(3);
    expect(
      (
        await createGithubCredentialStore({
          db: h.db,
          appSecret: SECRET,
          env: {},
        }).load()
      ).source,
    ).toBe("none");
    expect((await settingOf(h, "import_notice"))?.notImported).toEqual([]);
    expect(h.lines.join("\n")).not.toContain("VARIABLE_NOT_IMPORTED");
  });

  // #106-IM-14
  it("does not import a broken private key and names only the variable", async () => {
    const h = await installation();
    const broken =
      "-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5IGF0IGFsbA==\n-----END RSA PRIVATE KEY-----";

    await h.run(h.env({ GITHUB_APP_PRIVATE_KEY: broken }));

    expect(await settingOf(h, "github_app")).toBeUndefined();
    expect(await h.db.selectFrom("secrets").select("name").execute()).toEqual(
      [],
    );
    expect((await settingOf(h, "import_notice"))?.notImported).toEqual([
      {
        group: "github_app",
        problem: "invalid",
        variables: ["GITHUB_APP_PRIVATE_KEY"],
      },
    ]);
    const log = h.lines.join("\n");
    expect(log).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(log).not.toContain("bm90IGEga2V5");
    // The rest was imported.
    expect(await settingOf(h, "import_state")).toBe("done");
    expect(await memberships(h)).toHaveLength(3);
  });

  // #106-IM-15
  it("writes no secret, token or key to the log, in a successful import or in a failed one", async () => {
    const github = await startTestGithub();
    github.addUser({ id: 1001, login: "alice", name: null, email: null });
    github.addOrgMember("acme", "alice");
    const token = github.issueAccessToken("alice", {
      scope: "read:org",
      clientId: TEST_CLIENT_ID,
    });
    const h = await installation(
      { users: [{ login: "alice", githubId: 1001, token }] },
      { github },
    );
    const env = h.env({ ALLOWED_GITHUB_ORG: "acme" });

    await h.run(env, (step) => {
      // The failure's own text quotes secrets, as a careless error message could.
      if (step === "notice")
        throw new Error(`failed with ${LLM_KEY} and ${SECRET}`);
    });
    await h.run(env);

    const log = h.lines.join("\n");
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [
      SECRET,
      LLM_KEY,
      token,
      TEST_WEBHOOK_SECRET,
      "old-oauth-client-secret-value",
      testAppKeys().privateKey.split("\n")[1] ?? "?",
    ])
      expect(log, secret.slice(0, 6)).not.toContain(secret);
    // Variable names are what the log says.
    expect(log).toContain("GITHUB_APP_ID");
    expect(log).toContain("LLM_API_KEY");
  });

  // #106-IM-16
  it("treats an empty database as a fresh installation: nothing is imported and one hint says the variables are ignored", async () => {
    const h = await installation({
      users: [],
      installations: [],
      reviewDefaults: null,
    });

    const outcome = await h.run();

    expect(outcome).toEqual({
      kind: "not_needed",
      reason: "fresh",
      importedBefore: false,
    });
    expect(
      await h.db.selectFrom("instance_settings").selectAll().execute(),
    ).toEqual([]);
    expect(await h.db.selectFrom("secrets").selectAll().execute()).toEqual([]);
    expect((await readSetupState(h.db)).kind).toBe("fresh");
    const hints = h.lines.filter((line) =>
      line.includes("LEGACY_VARIABLES_IGNORED"),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("new installation");
    expect(hints[0]).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(hints[0]).not.toContain(LLM_KEY);
  });

  // #106-IM-01
  it("says once, naming only variables, that the old variables are ignored from now on", async () => {
    const h = await installation();

    await h.run();

    const hints = h.lines.filter((line) =>
      line.includes("LEGACY_VARIABLES_IGNORED"),
    );
    expect(hints).toHaveLength(1);
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "ALLOWED_GITHUB_LOGINS",
      "LLM_API_KEY",
    ])
      expect(hints[0]).toContain(name);
    expect(hints[0]).not.toContain("BETTER_AUTH_SECRET");
  });

  // #106-IM-01
  it("copies a model that differs from the built-in one into the review defaults of the default workspace, next to what the team saved", async () => {
    const h = await installation({ reviewDefaults: { maxFindings: 7 } });

    await h.run({ ...h.env(), LLM_MODEL: "openai/gpt-5.4-mini" });

    const row = await h.db
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", "review_defaults")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.value)).toEqual({
      maxFindings: 7,
      model: "openai/gpt-5.4-mini",
    });
  });

  // #106-IM-01
  it("keeps a model the team chose in the review defaults", async () => {
    const h = await installation({
      reviewDefaults: { model: "anthropic/claude-sonnet-5.5" },
    });

    await h.run({ ...h.env(), LLM_MODEL: "openai/gpt-5.4-mini" });

    const row = await h.db
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", "review_defaults")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.value)).toEqual({
      model: "anthropic/claude-sonnet-5.5",
    });
  });

  // #106-IM-07
  it("reports the OAuth app of the earlier sign in as not imported and an unusable organization name by variable", async () => {
    const h = await installation();

    await h.run(h.env({ ALLOWED_GITHUB_ORG: "not a valid org name!" }));

    const notice = await settingOf(h, "import_notice");
    expect(notice?.oauthApp).toBe(true);
    expect(notice?.notImported).toEqual([
      {
        group: "allowed_organization",
        problem: "invalid",
        variables: ["ALLOWED_GITHUB_ORG"],
      },
    ]);
  });

  // #106-IM-08
  it("leaves the instance without an Owner when no user qualifies, so that the wizard's admin becomes the Owner", async () => {
    const h = await installation();

    await h.run(h.env({ ALLOWED_GITHUB_LOGINS: "nobody-we-know" }));

    expect(await memberships(h)).toEqual([]);
    const workspace = await h.db
      .selectFrom("workspaces")
      .select("id")
      .executeTakeFirstOrThrow();
    expect(
      await h.db
        .selectFrom("workspace_members")
        .select("user_id")
        .where("workspace_id", "=", workspace.id)
        .execute(),
    ).toEqual([]);
  });
});
