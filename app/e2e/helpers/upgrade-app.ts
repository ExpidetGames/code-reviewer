// SPDX-License-Identifier: LicenseRef-Proprietary

// What the journey of the update from the previous release (e2e/upgrade/) needs to play the operator: the
// database of the previous release, the environment of the previous release and of the new one, and the app
// itself as a process the journey starts, stops and starts again (the production build `next start`, the same
// build the other apps use), with the output of each start in a log file of its own, like `docker compose logs`
// shows it. Everything here is the operator's side; the app is not touched except through its environment, its
// database file and its HTTP routes.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { expect, type APIRequestContext } from "@playwright/test";
import { e2eEnv, upgradeEnv } from "./e2e-env";
import {
  allowedLogins,
  UPGRADE_INSTALLATION_ID,
  UPGRADE_ORG,
  UPGRADE_PEOPLE,
  UPGRADE_WIDGETS,
  UPGRADE_GADGETS,
  upgradeSeed,
} from "./upgrade-fixture";

const run = promisify(execFile);
const APP_DIRECTORY = process.cwd();
const absolute = (path: string) => resolve(APP_DIRECTORY, path);
const NEXT = absolute("node_modules/next/dist/bin/next");
const CLI = absolute("src/test-support/legacy-installation-cli.ts");

export const upgradePaths = {
  directory: absolute(upgradeEnv.directory),
  database: absolute(upgradeEnv.databasePath),
  backups: absolute(upgradeEnv.backupDir),
};

/** An empty working directory for the journey: no database, no backup, no log. */
export function resetUpgradeDirectory(): void {
  rmSync(upgradePaths.directory, { recursive: true, force: true });
  mkdirSync(resolve(upgradePaths.database, ".."), { recursive: true });
  mkdirSync(upgradePaths.backups, { recursive: true });
}

/**
 * Makes the fake GitHub know the people, the organization and the installation of the old installation, mints
 * the access tokens their last sign ins would have left, and writes the database of the previous release.
 */
export async function makeDatabaseOfThePreviousRelease(
  request: APIRequestContext,
): Promise<Record<string, string>> {
  const github = e2eEnv.githubUrl;
  const tokens: Record<string, string> = {};
  for (const person of UPGRADE_PEOPLE) {
    const added = await request.post(`${github}/__fake/users`, {
      data: {
        id: person.id,
        login: person.login,
        name: person.name,
        email: person.email,
      },
    });
    expect(added.status()).toBe(201);
    if (person.inOrganization) {
      const member = await request.post(`${github}/__fake/org-members`, {
        data: { org: UPGRADE_ORG.login, login: person.login },
      });
      expect(member.status()).toBe(201);
    }
    // The token of the last sign in of the old installation: the OAuth app asked for read:org.
    const issued = await request.post(`${github}/__fake/tokens`, {
      data: { login: person.login, scope: "read:user user:email read:org" },
    });
    expect(issued.status()).toBe(201);
    tokens[person.login] = ((await issued.json()) as { token: string }).token;
  }
  const installed = await request.post(`${github}/__fake/installations`, {
    data: {
      installation: {
        id: UPGRADE_INSTALLATION_ID,
        account: { ...UPGRADE_ORG, type: "Organization" },
      },
      repositories: [UPGRADE_WIDGETS, UPGRADE_GADGETS],
    },
  });
  expect(installed.status()).toBe(201);

  const seedPath = resolve(upgradePaths.directory, "seed.json");
  writeFileSync(
    seedPath,
    JSON.stringify(upgradeSeed(upgradeEnv.legacySecret, tokens)),
  );
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CLI,
      upgradePaths.database,
      seedPath,
    ],
    { cwd: APP_DIRECTORY },
  );
  return tokens;
}

/** The environment of the installation as the previous release was run: everything in variables. */
export function environmentOfThePreviousRelease(
  githubPrivateKey: string,
): Record<string, string> {
  return {
    ...environmentOfTheServer(),
    BETTER_AUTH_SECRET: upgradeEnv.legacySecret,
    GITHUB_OAUTH_CLIENT_ID: upgradeEnv.oauthClientId,
    GITHUB_OAUTH_CLIENT_SECRET: upgradeEnv.oauthClientSecret,
    ALLOWED_GITHUB_LOGINS: allowedLogins(),
    ALLOWED_GITHUB_ORG: UPGRADE_ORG.login,
    GITHUB_APP_ID: e2eEnv.githubAppId,
    GITHUB_APP_SLUG: e2eEnv.githubAppSlug,
    GITHUB_APP_PRIVATE_KEY: githubPrivateKey,
    GITHUB_APP_WEBHOOK_SECRET: e2eEnv.githubAppWebhookSecret,
    LLM_PROVIDER: "openrouter",
    LLM_API_KEY: upgradeEnv.llmKey,
    LLM_MODEL: "test/fake-model",
    LLM_MAX_TOKENS: "32000",
  };
}

/**
 * The environment after the update and the short setup, once the operator removed the old variables: the master
 * key under its new name with the same value, and what is technical (the address, the runner token, the paths).
 */
export function environmentOfTheNewRelease(): Record<string, string> {
  return {
    ...environmentOfTheServer(),
    APP_SECRET: upgradeEnv.legacySecret,
  };
}

function environmentOfTheServer(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    NODE_ENV: "production",
    // A production server fetches the models.dev catalog on its own (#548); no test reaches the internet.
    MODELS_DEV_FETCH: "off",
    DATABASE_PATH: upgradePaths.database,
    BACKUP_DIR: upgradePaths.backups,
    BETTER_AUTH_URL: e2eEnv.upgradeAppUrl,
    RUNNER_TOKEN: e2eEnv.runnerToken,
    // The test stack's address of GitHub, as every app under test has it.
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    GITHUB_API_BASE_URL: e2eEnv.githubUrl,
    GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
    LLM_MODEL: "test/fake-model",
    LLM_MAX_TOKENS: "32000",
  };
}

export type UpgradeApp = {
  /** The log file of this start. */
  logFile: string;
  /** What the app printed so far. */
  output(): string;
  /** The exit code once the process has ended by itself or was stopped; null while it runs. */
  exitCode(): number | null;
  /** SIGTERM, then SIGKILL. */
  stop(): Promise<void>;
};

let starts = 0;

/**
 * Starts the app with this environment and waits until it answers its health check, or until it has ended (a
 * start that fails ends with one readable line and exit code 1: the caller looks at `exitCode()` and the log).
 */
export async function startUpgradeApp(
  environment: Record<string, string>,
): Promise<UpgradeApp> {
  starts += 1;
  const logFile = resolve(
    upgradePaths.directory,
    `app-start-${String(starts)}.log`,
  );
  const fd = openSync(logFile, "w");
  const child: ChildProcess = spawn(
    process.execPath,
    [
      NEXT,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(e2eEnv.upgradeAppPort),
    ],
    {
      cwd: APP_DIRECTORY,
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);
  const ended = new Promise<void>((done) => {
    child.once("exit", () => done());
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const onExit = () => {
    if (isRunning()) child.kill("SIGKILL");
  };
  process.on("exit", onExit);

  const app: UpgradeApp = {
    logFile,
    output: () => readFileSync(logFile, "utf8"),
    exitCode: () => (isRunning() ? null : child.exitCode),
    async stop() {
      process.removeListener("exit", onExit);
      if (!isRunning()) return;
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await ended;
      clearTimeout(killer);
    },
  };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (!isRunning()) return app;
    try {
      const answer = await fetch(`${e2eEnv.upgradeAppUrl}/api/health`);
      if (answer.ok) return app;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await app.stop();
      throw new Error(
        `The app did not answer its health check in time:\n${app.output()}`,
      );
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Reads rows from the app's database file through a connection of its own (read only). */
export function readUpgradeDatabase<T = Record<string, unknown>>(
  sql: string,
  ...parameters: unknown[]
): T[] {
  const db = new Database(upgradePaths.database, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db.prepare(sql).all(...parameters) as T[];
  } finally {
    db.close();
  }
}

/** The tables of a SQLite file (the app's or a backup's). */
export function tablesOf(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}
