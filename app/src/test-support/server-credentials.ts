// SPDX-License-Identifier: Apache-2.0

// Puts the GitHub App and the LLM key into the database of a test the way the admin portal and the workspace
// settings do, for the tests of the route files: the server reads both from the database now (the variables of
// an installation from before accounts are imported once, src/legacy-import/), so a test that wants a server
// that is connected to GitHub, or reviews that have a key, saves them. What a test leaves out is missing, which
// is how those tests make "the webhook secret is missing" or "GitHub is not configured".
import type { Kysely } from "kysely";
import { createGithubCredentialStore } from "../github-config/credentials.ts";
import type { Database } from "../db/schema.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { defaultWorkspaceId } from "./workspaces.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Saves the App described by the `GITHUB_APP_*` entries of `env` (what is missing there is missing in the
 * database: no id or slug means no App at all). `APP_SECRET` of `env` is the master key.
 */
export async function saveGithubAppFromEnv(
  db: Kysely<Database>,
  env: Env,
): Promise<void> {
  const appSecret = env.APP_SECRET ?? "";
  const store = createGithubCredentialStore({ db, appSecret, env: {} });
  const appId = (env.GITHUB_APP_ID ?? "").trim();
  const slug = (env.GITHUB_APP_SLUG ?? "").trim();
  if (appId === "" || slug === "") return;
  await store.persistApp({
    actorId: null,
    stored: {
      appId,
      slug,
      clientId: null,
      privateApp: true,
      origin: "manual",
    },
    privateKey: env.GITHUB_APP_PRIVATE_KEY ?? null,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET ?? null,
    clientSecret: { kind: "keep" },
  });
}

/** Saves `apiKey` as the LLM key of the default workspace (made if it does not exist). */
export async function saveDefaultWorkspaceLlmKey(
  db: Kysely<Database>,
  appSecret: string,
  apiKey: string,
): Promise<void> {
  const workspaceId = await defaultWorkspaceId(db);
  const saved = await createWorkspaceLlm({
    db,
    appSecret: () => appSecret,
    env: () => ({}),
  })
    .keyServiceFor(workspaceId)
    .save({ provider: "openrouter", apiKey }, null);
  if (!saved.ok) throw new Error("The test LLM key was refused.");
}
