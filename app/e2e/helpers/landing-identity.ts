// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the landing identity (the PostHog identifiers code-review.com hands over, #692) that an app stored on a user.
// The app shows it nowhere, so the journey asks the database of the app.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { e2eEnv } from "./e2e-env";

const run = promisify(execFile);

export type StoredLandingIdentity = {
  distinctId: string | null;
  sessionId: string | null;
  capturedAt: string | null;
} | null;

/** What the app stored for the user with this address, or null when there is no such user. */
export async function landingIdentityOf(
  email: string,
  app: "signup" | "main" = "signup",
): Promise<StoredLandingIdentity> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      resolve(process.cwd(), "src/test-support/e2e-landing-identity-child.ts"),
      "read",
      app === "signup" ? e2eEnv.signupDatabaseUrl : e2eEnv.databaseUrl,
      email,
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout) as StoredLandingIdentity;
}
