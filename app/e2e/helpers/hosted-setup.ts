// SPDX-License-Identifier: LicenseRef-Proprietary

// The first-run setup of an app in its serverless mode (#321, #332): there is no log to read the code from, the
// operator makes it with `pnpm setup-code` against the database of the deployment. The same command, then the same two
// routes as `setUpApp` (e2e/helpers/setup.ts).
import { expect, request } from "@playwright/test";
import { e2eEnv } from "./e2e-env";
import { hostedDatabaseUrls } from "./hosted-env";
import { rememberSecret } from "./hosted-secrets";
import { makeSetupCode as makeCode } from "./setup";

/** What the operator's `pnpm setup-code` prints: a new code, which ends the one before. */
export async function makeSetupCode(): Promise<string> {
  const code = await makeCode(hostedDatabaseUrls().app);
  rememberSecret("setup-code", code);
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
