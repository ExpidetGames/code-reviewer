// SPDX-License-Identifier: LicenseRef-Proprietary

// Helpers for the first-run setup. A new instance prints its setup code in the log of the app and
// nowhere else, so the journeys read it from the log file the app's output is redirected to
// (playwright.config.ts), the way an operator reads `docker compose logs`.
import { readFileSync } from "node:fs";
import { expect, request, type APIRequestContext } from "@playwright/test";
import { e2eEnv, githubAppPrivateKey } from "./e2e-env";

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
  tenancy: "single" | "multi" = "single",
): Promise<void> {
  const client: APIRequestContext = await request.newContext({ baseURL });
  try {
    const accepted = await client.post("/api/setup/code", {
      data: { code: readSetupCode(logFile) },
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
