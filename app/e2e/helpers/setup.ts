// SPDX-License-Identifier: Apache-2.0

// Helpers for the first-run setup. A new instance prints its setup code in the log of the app and
// nowhere else, so the journeys read it from the log file the app's output is redirected to
// (playwright.config.ts), the way an operator reads `docker compose logs`.
import { readFileSync } from "node:fs";
import { expect, request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

/** The setup code the app under test printed. Fails when the log has none, or more than one line. */
export function readSetupCode(logFile: string): string {
  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => /Setup code: \d{6}\b/.test(line));
  expect(
    lines,
    `${logFile} must hold exactly one setup code line (a restart prints another)`,
  ).toHaveLength(1);
  const match = /Setup code: (\d{6})\b/.exec(lines[0] ?? "");
  return match?.[1] ?? "";
}

/**
 * Sets the app at `baseURL` up the way the wizard would, through the same two routes: enters the
 * code from `logFile` and finishes the wizard as single-tenant with the admin of `e2eEnv`. Each app
 * under test is set up once per run, before the journeys that use it (e2e/setup/prepare-apps.e2e.ts).
 */
export async function setUpApp(
  baseURL: string,
  logFile: string,
): Promise<void> {
  const client: APIRequestContext = await request.newContext({ baseURL });
  try {
    const accepted = await client.post("/api/setup/code", {
      data: { code: readSetupCode(logFile) },
    });
    expect(accepted.status()).toBe(200);
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
