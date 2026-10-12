// SPDX-License-Identifier: Apache-2.0

// The update of a running installation, end to end: the database and the environment of the previous release
// (five people who signed in with GitHub, a connection with two repositories, finished reviews, the GitHub App,
// the LLM key and the allow list in variables, `BETTER_AUTH_SECRET` only) are started with the new version, and
// the operator does what the guide says: reads the setup code in the log, answers the three questions, removes
// the old variables. Reviews must never be interrupted, so a signed webhook and the REAL runner with the REAL
// PR-Agent produce a review comment at the fake GitHub while the setup is still open, after the setup, and
// after the old variables are gone. The import runs once (a restart before and after the wizard imports
// nothing twice), a backup is taken first and a backup that cannot be written stops the update before the
// database is touched, and no secret is in the log. The details of each rule are proven at lower levels
// (src/legacy-import/); this file proves they fit together in the built app.
import { expect, request, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { e2eEnv, githubAppPrivateKey, upgradeEnv } from "../helpers/e2e-env";
import {
  addGithubPullRequest,
  getIssuedInstallationTokens,
  getPullRequestComments,
  userMenuButton,
} from "../helpers/github-fake";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import { readSetupCode } from "../helpers/setup";
import {
  environmentOfTheNewRelease,
  environmentOfThePreviousRelease,
  makeDatabaseOfThePreviousRelease,
  readUpgradeDatabase,
  resetUpgradeDirectory,
  startUpgradeApp,
  tablesOf,
  upgradePaths,
  type UpgradeApp,
} from "../helpers/upgrade-app";
import {
  UPGRADE_INSTALLATION_ID,
  UPGRADE_ORG,
  UPGRADE_PEOPLE,
  UPGRADE_WIDGETS,
} from "../helpers/upgrade-fixture";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
const RUN_TIMEOUT = 120_000;
// A retry starts the whole serial group again on the same fake GitHub, which keeps the comments of the failed
// attempt: every attempt works on pull requests of its own (the number moves by 100 per retry), so a stale comment
// can never satisfy the wait for a new one.
const prNumber = (base: number) => base + 100 * test.info().retry;
const person = (login: string) => {
  const found = UPGRADE_PEOPLE.find((candidate) => candidate.login === login);
  if (found === undefined) throw new Error(`No such person ${login}`);
  return found;
};
const NEW_ADMIN = {
  email: "operator@upgrade.test",
  password: "upgrade-operator-passphrase-orbit-lantern-55",
};

// One app, one runner and one fake LLM, used by the tests one after the other: they are the steps of one update.
test.describe.configure({ mode: "serial" });

// The whole update is one core path of an existing installation (the staging instance among them), and its steps
// depend on each other, so the group is tagged as a whole: a run that selects @smoke runs all of it or none.
test.describe(
  "an installation of the previous release is updated",
  { tag: "@smoke" },
  () => {
    let app: UpgradeApp | undefined;
    let llm: FakeLlm | undefined;
    let runner: RunnerProcess | undefined;
    let tokens: Record<string, string> = {};
    const privateKey = () => githubAppPrivateKey();

    function theApp(): UpgradeApp {
      if (app === undefined) throw new Error("The app was not started.");
      return app;
    }
    function theLlm(): FakeLlm {
      if (llm === undefined) throw new Error("The fake LLM was not started.");
      return llm;
    }

    /** Everything the operator could read or search for secrets: the app's logs, the runner's output. */
    function everything(): string {
      return [...logsOfEveryStart(), runner?.output() ?? ""].join("\n");
    }
    function logsOfEveryStart(): string[] {
      return readdirSync(upgradePaths.directory)
        .filter((name) => name.startsWith("app-start-"))
        .map((name) =>
          readFileSync(join(upgradePaths.directory, name), "utf8"),
        );
    }

    /** None of the secrets of the old installation is anywhere an operator can read. */
    async function expectNoSecrets(
      api: import("@playwright/test").APIRequestContext,
    ): Promise<void> {
      const installationTokens = await getIssuedInstallationTokens(api);
      const text = everything();
      for (const secret of [
        upgradeEnv.legacySecret,
        upgradeEnv.llmKey,
        upgradeEnv.oauthClientSecret,
        e2eEnv.githubAppWebhookSecret,
        e2eEnv.runnerToken,
        // A line of the private key's body is enough to find the key.
        privateKey().split("\n")[1] ?? "no key",
        ...Object.values(tokens),
        ...installationTokens,
      ])
        expect(
          text,
          `a secret (${secret.slice(0, 6)}...) is in a log`,
        ).not.toContain(secret);
    }

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      resetUpgradeDirectory();
      const api = await request.newContext();
      try {
        tokens = await makeDatabaseOfThePreviousRelease(api);
      } finally {
        await api.dispose();
      }
      llm = await startLlmFake();
      runner = await startRunner({
        appUrl: e2eEnv.upgradeAppUrl,
        llmBaseUrl: llm.baseUrl,
      });
    });

    test.beforeEach(() => {
      llm?.reset();
    });

    test.afterAll(async () => {
      await app?.stop();
      await runner?.stop();
      await llm?.close();
    });

    // #106-IM-17
    test("an update whose backup cannot be written does not start and leaves the database as the previous release left it", async () => {
      const before = tablesOf(upgradePaths.database);

      const failing = await startUpgradeApp({
        ...environmentOfThePreviousRelease(privateKey()),
        BACKUP_DIR: join(upgradePaths.directory, "no-such-volume"),
      });
      await expect.poll(() => failing.exitCode(), { timeout: 30_000 }).toBe(1);

      const log = failing.output();
      expect(log).toContain("UPDATE_BACKUP_FAILED");
      expect(log).toContain("BACKUP_TARGET_UNAVAILABLE");
      expect(log).toContain("the database was not changed");
      expect(log).not.toContain("Setup code");
      // Nothing of the update happened: the file is the previous release's, not migrated, not imported.
      expect(tablesOf(upgradePaths.database)).toEqual(before);
      expect(tablesOf(upgradePaths.database)).not.toContain("workspaces");
      expect(readdirSync(upgradePaths.backups)).toEqual([]);
    });

    // #106-IM-01, #106-IM-17
    test("after the cause is fixed the update backs up first, migrates, imports once and prints one setup code", async () => {
      app = await startUpgradeApp(
        environmentOfThePreviousRelease(privateKey()),
      );

      const log = theApp().output();
      expect(theApp().exitCode()).toBeNull();
      // The order an operator reads: the backup, the migrations, the import, the code.
      const positions = [
        "BACKUP_BEFORE_UPDATE",
        "[backup] created",
        "applied migrations",
        "IMPORT_DONE",
        "LEGACY_VARIABLES_IGNORED",
        "Setup code:",
      ].map((marker) => log.indexOf(marker));
      expect(
        positions.every((position) => position >= 0),
        log,
      ).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(readSetupCode(theApp().logFile)).toMatch(/^\d{6}$/);
      // The old variables are named, never shown.
      const ignored =
        log
          .split("\n")
          .find((line) => line.includes("LEGACY_VARIABLES_IGNORED")) ?? "";
      for (const name of [
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_WEBHOOK_SECRET",
        "GITHUB_OAUTH_CLIENT_SECRET",
        "ALLOWED_GITHUB_LOGINS",
        "ALLOWED_GITHUB_ORG",
        "LLM_API_KEY",
      ])
        expect(ignored).toContain(name);

      // The backup is the database as the previous release left it.
      const backups = readdirSync(upgradePaths.backups);
      expect(backups).toHaveLength(1);
      // Not one of the daily backups: the rotation of those never deletes the way back.
      expect(backups[0]).toMatch(
        /^code-reviewer-before-update-\d{8}T\d{6}Z\.db$/,
      );
      const backupTables = tablesOf(
        join(upgradePaths.backups, backups[0] ?? ""),
      );
      expect(backupTables).toContain("users");
      expect(backupTables).not.toContain("workspaces");

      // One workspace holds everything; the members are the people who pass the allow list of the moment.
      expect(readUpgradeDatabase("select slug from workspaces")).toEqual([
        { slug: "default" },
      ]);
      expect(
        readUpgradeDatabase(
          `select u.github_login as login, m.role as role from workspace_members m
         join users u on u.id = m.user_id order by u.created_at`,
        ),
      ).toEqual([
        { login: person("upgrade-alice").login, role: "owner" },
        { login: person("upgrade-bob").login, role: "member" },
        { login: person("upgrade-carol").login, role: "member" },
      ]);
      expect(
        readUpgradeDatabase<{ n: number }>(
          "select count(*) as n from users where imported_at is not null",
        )[0]?.n,
      ).toBe(UPGRADE_PEOPLE.length);
      expect(
        readUpgradeDatabase<{ n: number }>("select count(*) as n from jobs")[0]
          ?.n,
      ).toBe(2);
      // Whoever is not a member has no session any more, and the tokens of the earlier sign in are gone.
      expect(
        readUpgradeDatabase("select user_id from sessions order by user_id"),
      ).toEqual(
        ["upgrade-alice", "upgrade-bob", "upgrade-carol"].map((login) => ({
          user_id: `legacy-user-${String(person(login).id)}`,
        })),
      );
      expect(
        readUpgradeDatabase<{ n: number }>(
          "select count(*) as n from accounts where access_token is not null",
        )[0]?.n,
      ).toBe(0);
      expect(
        readUpgradeDatabase<{ key: string; value: string }>(
          "select key, value from instance_settings where key in ('import_state', 'setup_completed_at')",
        ),
      ).toEqual([{ key: "import_state", value: '"done"' }]);
      // The credentials are in the store, encrypted: not one of them is in the file in the clear.
      expect(
        readUpgradeDatabase("select name from secrets order by name"),
      ).toEqual([
        { name: "github_app_private_key" },
        { name: "github_app_webhook_secret" },
      ]);
      const rows = JSON.stringify([
        readUpgradeDatabase("select * from secrets"),
        readUpgradeDatabase("select * from workspace_secrets"),
      ]);
      expect(rows).not.toContain(upgradeEnv.llmKey);
      expect(rows).not.toContain(e2eEnv.githubAppWebhookSecret);

      const api = await request.newContext();
      try {
        await expectNoSecrets(api);
      } finally {
        await api.dispose();
      }
    });

    // #106-IM-02
    test("reviews are never interrupted: a signed webhook and the real runner produce a review comment while the setup is still open", async ({
      request: api,
    }) => {
      test.setTimeout(180_000);
      const number = prNumber(21);
      const head = `a${String(number).padStart(39, "0")}`;
      await addGithubPullRequest(api, UPGRADE_WIDGETS.fullName, {
        number,
        title: "Add a greeting helper",
        headSha: head,
      });
      const app = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        // A delivery signed with anything else is refused.
        const forged = await app.post("/api/webhooks/github-app", {
          data: "{}",
          headers: {
            "content-type": "application/json",
            "x-github-event": "pull_request",
            "x-github-delivery": "forged-1",
            "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
          },
        });
        expect(forged.status()).toBe(401);

        const answer = await deliverPullRequestEvent(app, {
          action: "opened",
          installationId: UPGRADE_INSTALLATION_ID,
          repository: {
            ...UPGRADE_WIDGETS,
            owner: { login: UPGRADE_ORG.login, id: UPGRADE_ORG.id },
          },
          number,
          title: "Add a greeting helper",
          headSha: head,
        });
        expect(answer).toEqual({
          status: "accepted",
          outcome: "trigger_enqueued",
        });
      } finally {
        await app.dispose();
      }

      await expect
        .poll(
          async () =>
            (
              await getPullRequestComments(
                api,
                UPGRADE_WIDGETS.fullName,
                number,
              )
            ).length,
          { timeout: RUN_TIMEOUT },
        )
        .toBe(1);
      const [comment] = await getPullRequestComments(
        api,
        UPGRADE_WIDGETS.fullName,
        number,
      );
      expect(comment?.login).toBe(e2eEnv.githubBotLogin);
      expect(comment?.body).toContain(REVIEW_MARKER);
      // The model was asked with the key of the old environment, which is now the key of the workspace.
      const asked = theLlm().requests();
      expect(asked).toHaveLength(1);
      expect(asked[0]?.authorization).toBe(`Bearer ${upgradeEnv.llmKey}`);
      await expectNoSecrets(api);
    });

    // #106-IM-22
    test("a restart before the wizard prints a new code and imports nothing twice", async ({
      request: api,
    }) => {
      const snapshot = () =>
        JSON.stringify([
          readUpgradeDatabase("select * from instance_settings order by key"),
          readUpgradeDatabase(
            "select * from workspace_members order by user_id",
          ),
          readUpgradeDatabase("select id, workspace_id from integrations"),
          readUpgradeDatabase(
            "select name, ciphertext from secrets order by name",
          ),
          readUpgradeDatabase("select name from workspace_secrets"),
          readUpgradeDatabase("select id from workspaces"),
        ]);
      const before = snapshot();
      const firstCode = readSetupCode(theApp().logFile);
      await theApp().stop();

      app = await startUpgradeApp(
        environmentOfThePreviousRelease(privateKey()),
      );

      const log = theApp().output();
      expect(log).not.toContain("IMPORT_DONE");
      expect(log).not.toContain("BACKUP_BEFORE_UPDATE");
      expect(log).toContain("LEGACY_VARIABLES_IGNORED");
      // A new code, for a process that has its own.
      expect(readSetupCode(theApp().logFile)).toMatch(/^\d{6}$/);
      void firstCode;
      expect(snapshot()).toBe(before);
      expect(readdirSync(upgradePaths.backups)).toHaveLength(1);
      await expectNoSecrets(api);
    });

    // #106-IM-02, #106-IM-08
    test("the short setup takes the code from the log and three answers, and the operator becomes an Owner next to the imported one", async () => {
      const api = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        const code = await api.post("/api/setup/code", {
          data: { code: readSetupCode(theApp().logFile) },
        });
        expect(code.status()).toBe(200);
        const done = await api.post("/api/setup/complete", {
          data: {
            tenancy: "single",
            signUp: { kind: "everyone" },
            admin: NEW_ADMIN,
          },
        });
        expect(done.status(), await done.text()).toBe(200);
        // The wizard is gone for good.
        expect((await api.get("/setup")).status()).toBe(404);
      } finally {
        await api.dispose();
      }

      expect(
        readUpgradeDatabase(
          `select u.github_login as login, m.role as role from workspace_members m
         join users u on u.id = m.user_id order by u.created_at`,
        ),
      ).toEqual([
        { login: "upgrade-alice", role: "owner" },
        { login: "upgrade-bob", role: "member" },
        { login: "upgrade-carol", role: "member" },
        // The operator, who has no GitHub login: an Owner next to the imported one.
        { login: null, role: "owner" },
      ]);
      // Sign in is email and password until the admin enables GitHub.
      expect(
        readUpgradeDatabase<{ value: string }>(
          "select value from instance_settings where key = 'sign_in_methods'",
        )[0]?.value,
      ).toBe('{"emailPassword":true,"github":false}');
    });

    // #106-IM-07
    test("the admin reads what changed: who was not made a member, the logins that never signed in, the organization that is not migrated", async ({
      page,
    }) => {
      await signInAsOperator(page);
      await page.goto("/admin");

      const notice = page.getByRole("note").filter({
        hasText: "This installation was updated",
      });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("upgrade-dave");
      await expect(notice).toContainText("was not on the list");
      await expect(notice).toContainText("upgrade-erin");
      await expect(notice).toContainText("could not be checked");
      await expect(notice).toContainText("upgrade-zed");
      await expect(notice).toContainText("organization is not migrated");
      await expect(notice).toContainText("GITHUB_OAUTH_CLIENT_SECRET");
      await expect(notice).toContainText("3 people are a member");
      // The App is the one of the old environment, and the sign in with GitHub waits for the admin.
      await expect(page.getByText("is configured.")).toContainText(
        e2eEnv.githubAppSlug,
      );
      await expect(
        page.getByText("Signing in with GitHub is not enabled yet"),
      ).toBeVisible();
      // No secret is on the page.
      const content = await page.content();
      for (const secret of [
        upgradeEnv.legacySecret,
        upgradeEnv.llmKey,
        upgradeEnv.oauthClientSecret,
        e2eEnv.githubAppWebhookSecret,
      ])
        expect(content).not.toContain(secret);

      await notice.getByRole("button", { name: "Hide this notice" }).click();
      await expect(notice).toHaveCount(0);
      await page.reload();
      await expect(notice).toHaveCount(0);
    });

    // #106-IM-02, #106-IM-11
    test("the operator removes the old variables and adds APP_SECRET with the value of BETTER_AUTH_SECRET: nothing is asked again and reviews go on", async ({
      request: api,
    }) => {
      test.setTimeout(180_000);
      await theApp().stop();

      app = await startUpgradeApp(environmentOfTheNewRelease());

      const log = theApp().output();
      expect(theApp().exitCode()).toBeNull();
      expect(log).not.toContain("Setup code");
      expect(log).not.toContain("IMPORT_DONE");
      expect(log).not.toContain("LEGACY_VARIABLES_IGNORED");
      expect(log).not.toContain("APP_SECRET_FROM_LEGACY_VARIABLE");
      const number = prNumber(22);
      const head = `b${String(number).padStart(39, "0")}`;
      await addGithubPullRequest(api, UPGRADE_WIDGETS.fullName, {
        number,
        title: "Add a farewell helper",
        headSha: head,
      });
      const app2 = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        const answer = await deliverPullRequestEvent(app2, {
          action: "opened",
          installationId: UPGRADE_INSTALLATION_ID,
          repository: {
            ...UPGRADE_WIDGETS,
            owner: { login: UPGRADE_ORG.login, id: UPGRADE_ORG.id },
          },
          number,
          title: "Add a farewell helper",
          headSha: head,
        });
        expect(answer.outcome).toBe("trigger_enqueued");
      } finally {
        await app2.dispose();
      }

      await expect
        .poll(
          async () =>
            (
              await getPullRequestComments(
                api,
                UPGRADE_WIDGETS.fullName,
                number,
              )
            ).length,
          { timeout: RUN_TIMEOUT },
        )
        .toBe(1);
      const asked = theLlm().requests();
      expect(asked).toHaveLength(1);
      expect(asked[0]?.authorization).toBe(`Bearer ${upgradeEnv.llmKey}`);
      await expectNoSecrets(api);
    });

    // #106-IM-19
    test("in a multi-tenant instance the workspace keeps its connection and its key, and the page says why Connect GitHub is unavailable", async ({
      page,
      request: api,
    }) => {
      test.setTimeout(180_000);
      const admin = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        await signInAsOperatorWith(admin);
        const changed = await admin.put("/api/admin/settings", {
          data: { tenancy: "multi" },
        });
        expect(changed.status(), await changed.text()).toBe(200);
      } finally {
        await admin.dispose();
      }

      await signInAsOperator(page);
      await page.goto("/w/default/connections");
      await expect(
        page.getByText("Connecting GitHub is not available yet"),
      ).toBeVisible();
      // The installation that was linked before the update is the workspace's connection.
      await expect(page.getByText(UPGRADE_ORG.login).first()).toBeVisible();

      const number = prNumber(23);
      const head = `c${String(number).padStart(39, "0")}`;
      await addGithubPullRequest(api, UPGRADE_WIDGETS.fullName, {
        number,
        title: "Add a salutation helper",
        headSha: head,
      });
      const app2 = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        const answer = await deliverPullRequestEvent(app2, {
          action: "opened",
          installationId: UPGRADE_INSTALLATION_ID,
          repository: {
            ...UPGRADE_WIDGETS,
            owner: { login: UPGRADE_ORG.login, id: UPGRADE_ORG.id },
          },
          number,
          title: "Add a salutation helper",
          headSha: head,
        });
        expect(answer.outcome).toBe("trigger_enqueued");
      } finally {
        await app2.dispose();
      }
      await expect
        .poll(
          async () =>
            (
              await getPullRequestComments(
                api,
                UPGRADE_WIDGETS.fullName,
                number,
              )
            ).length,
          { timeout: RUN_TIMEOUT },
        )
        .toBe(1);
      // The imported key is the workspace's: it works in a multi-tenant instance too.
      const asked = theLlm().requests();
      expect(asked).toHaveLength(1);
      expect(asked[0]?.authorization).toBe(`Bearer ${upgradeEnv.llmKey}`);

      // Back to one workspace for the rest of the journey.
      const back = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        await signInAsOperatorWith(back);
        const single = await back.put("/api/admin/settings", {
          data: { tenancy: "single" },
        });
        expect(single.status(), await single.text()).toBe(200);
      } finally {
        await back.dispose();
      }
    });

    // #106-IM-18
    test("people who signed in before sign in with GitHub only after the admin enabled it, and are recognised by their GitHub id", async ({
      page,
    }) => {
      const bob = person("upgrade-bob");
      const usersBefore = readUpgradeDatabase<{ n: number }>(
        "select count(*) as n from users",
      )[0]?.n;

      // Before: the login page offers email and password only, and the GitHub sign in is refused.
      await page.goto("/login");
      await expect(page.getByLabel("Email address")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign in with GitHub" }),
      ).toHaveCount(0);

      // The admin enters the client id and secret of the GitHub App's user authorization and switches it on.
      const admin = await request.newContext({ baseURL: e2eEnv.upgradeAppUrl });
      try {
        await signInAsOperatorWith(admin);
        const saved = await admin.put("/api/admin/github", {
          data: {
            userAuthorization: {
              clientId: e2eEnv.githubClientId,
              clientSecret: e2eEnv.githubClientSecret,
            },
          },
        });
        expect(saved.status(), await saved.text()).toBe(200);
        const confirmed = await admin.put("/api/admin/github", {
          data: { privateApp: true },
        });
        expect(confirmed.status(), await confirmed.text()).toBe(200);
        const methods = await admin.put("/api/admin/settings", {
          data: { signInMethods: { emailPassword: true, github: true } },
        });
        expect(methods.status(), await methods.text()).toBe(200);
      } finally {
        await admin.dispose();
      }

      // After: bob, an imported member, signs in with GitHub and is the same user as before.
      await page.goto("/login");
      await page.getByRole("button", { name: "Sign in with GitHub" }).click();
      await page
        .getByRole("button", { name: `Authorize ${bob.login}` })
        .click();
      await expect(page).toHaveURL(/\/w\/default\/projects$/);
      await expect(userMenuButton(page, bob)).toBeVisible();
      await expect(
        page.getByText(UPGRADE_WIDGETS.fullName).first(),
      ).toBeVisible();
      expect(
        readUpgradeDatabase<{ n: number }>("select count(*) as n from users")[0]
          ?.n,
      ).toBe(usersBefore);
      // The placeholder address is replaced by GitHub's verified one.
      expect(
        readUpgradeDatabase<{ email: string }>(
          "select email from users where github_login = ?",
          bob.login,
        )[0]?.email,
      ).toBe(bob.email);

      // Dave was not made a member: he can sign in but sees no workspace.
      await page.context().clearCookies();
      const dave = person("upgrade-dave");
      await page.goto("/login");
      await page.getByRole("button", { name: "Sign in with GitHub" }).click();
      await page
        .getByRole("button", { name: `Authorize ${dave.login}` })
        .click();
      await expect(page).toHaveURL(/\/no-access$/);
    });

    // #106-IM-23
    test("the admin links the GitHub identity of the imported Owner, and the two accounts become one", async ({
      page,
    }) => {
      const alice = person("upgrade-alice");
      await signInAsOperator(page);
      await page.goto("/admin/integrations");
      await expect(page.getByText("Not linked.")).toBeVisible();

      await page.getByRole("button", { name: "Link GitHub account" }).click();
      await page
        .getByRole("button", { name: `Authorize ${alice.login}` })
        .click();

      await expect(page).toHaveURL(/\/admin\/integrations\?github=merged$/);
      await expect(
        page.getByRole("status").filter({ hasText: "merged into this one" }),
      ).toBeVisible();
      // One account holds the identity, the email and password of the operator, and the Owner role.
      expect(
        readUpgradeDatabase(
          `select u.email as email, u.is_instance_admin as admin, m.role as role
         from users u
         join accounts a on a.user_id = u.id and a.provider_id = 'github'
         join workspace_members m on m.user_id = u.id
         where a.account_id = ?`,
          String(alice.id),
        ),
      ).toEqual([{ email: NEW_ADMIN.email, admin: 1, role: "owner" }]);
      expect(
        readUpgradeDatabase<{ n: number }>(
          "select count(*) as n from users where github_login = ? and is_instance_admin = 0",
          alice.login,
        )[0]?.n,
      ).toBe(0);
    });
  },
);

async function signInAsOperatorWith(
  client: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const signedIn = await client.post("/api/auth/sign-in/email", {
    data: NEW_ADMIN,
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
}

async function signInAsOperator(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(NEW_ADMIN.email);
  await page.getByLabel("Password").fill(NEW_ADMIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}
