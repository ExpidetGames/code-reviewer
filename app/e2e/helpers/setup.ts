// SPDX-License-Identifier: LicenseRef-Proprietary

// Helpers for the first-run setup. A new instance has no setup code until the operator makes one with
// `pnpm setup-code` against its database, so the journeys run the same command.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, request, type APIRequestContext } from "@playwright/test";
import { e2eEnv, githubAppPrivateKey } from "./e2e-env";

const run = promisify(execFile);

/**
 * What the operator's `pnpm setup-code` does against the database of an app of the run: a new code, valid for the next
 * `setUpApp` or the first-run journey. The code is read from the output of the command, nowhere else.
 */
export async function makeSetupCode(databaseUrl: string): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [
      "--conditions=react-server",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "src/setup/setup-code-cli.ts",
      // The output is a pipe here, which the command refuses unless it is told where the output goes.
      "--allow-pipe",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_SECRET: e2eEnv.appSecret,
        DATABASE_URL_MIGRATE: databaseUrl,
      },
    },
  );
  const code = /Setup code: (\d{6})\b/.exec(stdout)?.[1];
  if (code === undefined) throw new Error("setup-code printed no code.");
  return code;
}

/**
 * Sets the app at `baseURL` up the way the wizard would, through the same two routes: enters a code from
 * `pnpm setup-code` against `databaseUrl` and finishes the wizard as single-tenant (or multi-tenant) with the admin
 * of `e2eEnv`. Each app under test is set up once per run, before the journeys that use it
 * (e2e/setup/prepare-apps.e2e.ts).
 */
export async function setUpApp(
  baseURL: string,
  databaseUrl: string,
  tenancy: "single" | "multi" = "single",
): Promise<void> {
  const client: APIRequestContext = await request.newContext({ baseURL });
  try {
    const accepted = await client.post("/api/setup/code", {
      data: { code: await makeSetupCode(databaseUrl) },
    });
    expect(accepted.status()).toBe(200);
    const completed = await client.post("/api/setup/complete", {
      data: {
        tenancy,
        signUp: { kind: "everyone" },
        admin: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
      },
    });
    expect(completed.status(), await completed.text()).toBe(200);
  } finally {
    await client.dispose();
  }
}

/**
 * Enters the GitHub App of the fake GitHub in the admin portal of the app at `baseURL`, with the form of the
 * manual way and the instance admin's own session: the same route and the same checks an operator meets
 * (the key is checked against the fake's `GET /app`, the client id and secret against its token check). The
 * apps are not configured through the environment any more, so every app that signs people in with GitHub or
 * reviews pull requests needs this once per run (e2e/setup/prepare-apps.e2e.ts).
 */
export async function enterGithubApp(baseURL: string): Promise<void> {
  const client: APIRequestContext = await request.newContext({ baseURL });
  try {
    const signedIn = await client.post("/api/auth/sign-in/email", {
      data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const saved = await client.put("/api/admin/github", {
      data: {
        app: {
          appId: e2eEnv.githubAppId,
          slug: e2eEnv.githubAppSlug,
          privateKey: githubAppPrivateKey(),
          webhookSecret: e2eEnv.githubAppWebhookSecret,
          clientId: e2eEnv.githubClientId,
          clientSecret: e2eEnv.githubClientSecret,
          privateApp: true,
        },
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
  } finally {
    await client.dispose();
  }
}
