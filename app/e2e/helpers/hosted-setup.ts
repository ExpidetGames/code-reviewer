// SPDX-License-Identifier: Apache-2.0

// The first-run setup of an app in its serverless mode (#321, #332): there is no log to read the code from, the
// operator makes it with `pnpm setup-code` against the database of the deployment. The same command, then the same two
// routes as `setUpApp` (e2e/helpers/setup.ts).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, request } from "@playwright/test";
import { e2eEnv } from "./e2e-env";
import { hostedDatabaseUrls, hostedEnv } from "./hosted-env";

const run = promisify(execFile);

/** What the operator's `pnpm setup-code` prints: a new code, which ends the one before. */
export async function makeSetupCode(): Promise<string> {
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
        APP_RUNTIME: "serverless",
        APP_SECRET: hostedEnv.appSecret,
        DATABASE_URL_MIGRATE: hostedDatabaseUrls().app,
      },
    },
  );
  const code = /Setup code: (\d{6})\b/.exec(stdout)?.[1];
  if (code === undefined) throw new Error("setup-code printed no code.");
  return code;
}

/** Sets the app up like the wizard does, as single-tenant with the admin of `e2eEnv`. */
export async function setUpHostedApp(baseURL: string): Promise<void> {
  const client = await request.newContext({ baseURL });
  try {
    const accepted = await client.post("/api/setup/code", {
      data: { code: await makeSetupCode() },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    const completed = await client.post("/api/setup/complete", {
      data: {
        tenancy: "single",
        signUp: { kind: "everyone" },
        admin: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
      },
    });
    expect(completed.status(), await completed.text()).toBe(200);
  } finally {
    await client.dispose();
  }
}
