// SPDX-License-Identifier: LicenseRef-Proprietary

// The admin portal's data route, called the way a script of an operator would: sign in with email and
// password, then change a setting with the session cookie. Used by a journey to put an app into a known
// state before its steps (and so to survive a retry); the journey itself uses the pages.
import { expect, request } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

export async function changeAdminSetting(
  baseURL: string,
  change: Record<string, unknown>,
): Promise<void> {
  const client = await request.newContext({ baseURL });
  try {
    const signedIn = await client.post("/api/auth/sign-in/email", {
      data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const changed = await client.put("/api/admin/settings", { data: change });
    expect(changed.status(), await changed.text()).toBe(200);
  } finally {
    await client.dispose();
  }
}

/** Configures the mail server of the app at `baseURL` to send to the fake SMTP server (STARTTLS). */
export async function configureFakeMailServer(baseURL: string): Promise<void> {
  await changeAdminSetting(baseURL, {
    smtp: {
      host: e2eEnv.smtp.host,
      port: e2eEnv.smtp.port,
      security: "starttls",
      user: e2eEnv.smtp.user,
      password: e2eEnv.smtp.password,
      senderAddress: "code-reviewer@e2e.test",
      senderName: "code-review.com",
      allowSelfSigned: true,
    },
  });
}

/** Removes the mail server of the app at `baseURL`. */
export async function removeMailServer(baseURL: string): Promise<void> {
  await changeAdminSetting(baseURL, { smtp: null });
}

/**
 * Reads the installations and repositories from the (fake) GitHub into the app at `baseURL`, the way the
 * "Sync from GitHub" button does: with the instance admin's session, because the synchronization reads every
 * connection of the instance and is the admin's (`POST /api/admin/integrations/sync`). A journey about a
 * person who is no instance admin calls this to get the repositories into the app before it signs in.
 */
export async function syncFromGithubAsAdmin(baseURL: string): Promise<void> {
  const client = await request.newContext({ baseURL });
  try {
    const signedIn = await client.post("/api/auth/sign-in/email", {
      data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const synced = await client.post("/api/admin/integrations/sync");
    expect(synced.status(), await synced.text()).toBe(200);
    expect(((await synced.json()) as { errors: unknown[] }).errors).toEqual([]);
  } finally {
    await client.dispose();
  }
}
