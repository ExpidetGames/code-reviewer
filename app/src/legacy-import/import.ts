// SPDX-License-Identifier: Apache-2.0

// The import of an existing installation (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11): the
// data of the instance moves into the new model once, in ONE transaction that also sets `import_state` to
// `done`. A failure leaves nothing behind (the transaction rolls back and the marker stays `none`), so the next
// start runs the whole import again. The backup is taken before this runs and outside the transaction
// (backup-step.ts).
//
// What it does, in the transaction:
//   1. the default workspace (the migration made it when the installation held data; made here if it is missing);
//   2. every user is marked as imported (`users.imported_at`);
//   3. the users who pass the allow list of the moment become members, the earliest created is the Owner
//      (members.ts). The checks that ask GitHub are done BEFORE the transaction opens, so a write lock is
//      never held while the network is waited for;
//   4. the GitHub App of `GITHUB_APP_*` moves into the encrypted store (id, slug, private key, webhook secret);
//      a variable that is not usable is not imported and only named;
//   5. the LLM key of `LLM_PROVIDER` / `LLM_API_KEY` becomes the default workspace's key, and `LLM_MODEL` its
//      model (a review default) when it differs from the built-in one;
//   6. GitHub sign-in is switched off (`sign_in_methods`): the GitHub App has no user authorization yet, the
//      admin enables it in the portal;
//   7. the notice for the admin and the marker.
// Nothing that is already configured is overwritten: a later start finds `import_state` `done` and does
// nothing.
//
// Nothing here logs a value. The log lines name variables and counts.
import type { Kysely } from "kysely";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  createLegacyUsersRepository,
  type LegacyUser,
} from "../db/repositories/legacy-users-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { formatTimestamp } from "../db/codecs.ts";
import {
  CLIENT_SECRET,
  PRIVATE_KEY_SECRET,
  WEBHOOK_SECRET,
} from "../github-config/credentials.ts";
import type { OrgMembership } from "../auth/github-org.ts";
import { createWorkspaceLlmKeyService } from "../llm/workspace-key.ts";
import { parseStoredOverrides } from "../review-settings/validate.ts";
import { REVIEW_DEFAULTS_KEY } from "../review-settings/service.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import {
  decideMembers,
  pickOwner,
  type MemberDecision,
  type OrgCheckOutcome,
} from "./members.ts";
import {
  readLegacyEnvironment,
  type LegacyEnvironment,
} from "./environment.ts";
import {
  buildImportNotice,
  noticeHasContent,
  type ImportNotice,
} from "./notice.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The steps of the transaction, in order; a test can fail the import after any of them. */
export const IMPORT_STEPS = [
  "workspace",
  "users",
  "members",
  "github_app",
  "llm",
  "sign_in_methods",
  "notice",
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export type ImportLog = {
  info(message: string): void;
  warn(message: string): void;
};

export type ImportDependencies = {
  db: Kysely<Database>;
  env: Env;
  /** The master key (`APP_SECRET`, or the deprecated `BETTER_AUTH_SECRET`). */
  appSecret: string;
  /** Decrypts the GitHub access token of the earlier sign in as Better Auth stored it; throws if it cannot. */
  decryptToken(stored: string): Promise<string>;
  /** Asks GitHub whether the account of the token is a member of the allowed organization. */
  checkMembership(
    accessToken: string,
    organization: string,
  ): Promise<OrgMembership>;
  log?: ImportLog;
  now?: () => Date;
  newId?: () => string;
  /** Test hook: runs after each step of the transaction; throwing fails (and rolls back) the import. */
  afterStep?: (step: ImportStep) => void | Promise<void>;
};

export type ImportSummary = {
  members: number;
  notMembers: number;
  usersMarked: number;
  githubApp: "imported" | "absent" | "not_usable" | "already_configured";
  llmKey: "imported" | "absent" | "not_usable" | "already_configured";
  llmModel: "imported" | "not_needed";
  notice: boolean;
};

export type ImportOutcome =
  | {
      kind: "not_needed";
      reason: "set_up" | "already_imported" | "fresh";
      /** Whether an import ran here at some time (`import_state` `done`). */
      importedBefore: boolean;
    }
  | { kind: "imported"; summary: ImportSummary };

const DEFAULT_LOG: ImportLog = { info: console.info, warn: console.warn };

function groupOf(
  legacy: LegacyEnvironment,
  env: Env,
): ImportNotice["notImported"] {
  const entries: ImportNotice["notImported"] = [];
  if (legacy.github.kind === "unusable")
    entries.push({
      group: "github_app",
      problem: legacy.github.problem,
      variables: legacy.github.variables,
    });
  if (legacy.llm.kind === "unusable")
    entries.push({
      group: "llm_key",
      problem: "invalid",
      variables: legacy.llm.variables,
    });
  if (
    (env.ALLOWED_GITHUB_ORG ?? "").trim() !== "" &&
    legacy.access.org === null
  )
    entries.push({
      group: "allowed_organization",
      problem: "invalid",
      variables: ["ALLOWED_GITHUB_ORG"],
    });
  return entries;
}

/** Decides the members: the list part, then the live checks of the organization. Outside any transaction. */
async function prepareMembers(
  deps: ImportDependencies,
  users: LegacyUser[],
  legacy: LegacyEnvironment,
): Promise<MemberDecision[]> {
  const pins = new Map(
    (await createAllowedLoginPinsRepository(deps.db).list()).map((pin) => [
      pin.login,
      pin.githubId,
    ]),
  );
  const organization = legacy.access.org;
  const checkOrganization = async (
    user: LegacyUser,
  ): Promise<OrgCheckOutcome> => {
    if (organization === null) return "unavailable";
    if (user.accessToken === null || user.accessToken === "") return "no_token";
    let token: string;
    try {
      token = await deps.decryptToken(user.accessToken);
    } catch {
      // Another APP_SECRET than the one the token was stored with, or a damaged value.
      return "undecryptable";
    }
    return deps.checkMembership(token, organization);
  };
  return decideMembers({
    users,
    config: legacy.access,
    pins,
    checkOrganization,
  });
}

export async function importExistingInstallation(
  deps: ImportDependencies,
): Promise<ImportOutcome> {
  const { db, env } = deps;
  const log = deps.log ?? DEFAULT_LOG;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const settings = createInstanceSettingsRepository(db, now);
  const importedBefore = (await settings.get("import_state")) === "done";
  if ((await settings.get("setup_completed_at")) != null)
    return { kind: "not_needed", reason: "set_up", importedBefore };
  if (importedBefore)
    return { kind: "not_needed", reason: "already_imported", importedBefore };
  const users = await createLegacyUsersRepository(db).list();
  if (users.length === 0)
    return { kind: "not_needed", reason: "fresh", importedBefore };

  const legacy = readLegacyEnvironment(env);
  const decisions = await prepareMembers(deps, users, legacy);

  const summary = await db.transaction().execute(async (trx) => {
    const at = now();
    const timestamp = formatTimestamp(at);
    const step = async (name: ImportStep) => deps.afterStep?.(name);
    const instance = createInstanceSettingsRepository(trx, () => at);
    const workspaces = createWorkspacesRepository(trx, () => at, newId);

    // The marker again, inside the transaction that sets it: a second start at the same moment (two
    // processes on one file) imports once.
    if ((await instance.get("import_state")) === "done") return null;

    // 1. The workspace.
    const workspace =
      (await workspaces.findDefault()) ??
      (await workspaces.create({
        name: "Default workspace",
        slug: "default",
        createdBy: null,
      }));
    await step("workspace");

    // 2. The users.
    const usersMarked =
      await createLegacyUsersRepository(trx).markAllImported(timestamp);
    await step("users");

    // 3. The members.
    const ownerId = pickOwner(users, decisions);
    let members = 0;
    for (const user of users) {
      const decision = decisions.find((d) => d.userId === user.id);
      if (decision === undefined || !decision.allowed) continue;
      await workspaces.addMember(
        workspace.id,
        user.id,
        user.id === ownerId ? "owner" : "member",
      );
      members += 1;
    }
    await step("members");

    // 4. The GitHub App.
    const githubApp = await importGithubApp({
      trx,
      legacy,
      appSecret: deps.appSecret,
      now: () => at,
    });
    await step("github_app");

    // 5. The LLM key and model.
    const llm = await importLlm({
      trx,
      legacy,
      workspaceId: workspace.id,
      appSecret: deps.appSecret,
      now: () => at,
    });
    await step("llm");

    // 6. Sign in: email and password until the admin enables GitHub (the App has no user authorization yet).
    if ((await instance.get("sign_in_methods")) === undefined)
      await instance.set(
        "sign_in_methods",
        { emailPassword: true, github: false },
        null,
      );
    await step("sign_in_methods");

    // 7. The notice and the marker.
    const loginsWithUsers = new Set(
      users
        .map((user) => user.githubLogin?.toLowerCase())
        .filter((login): login is string => login !== undefined),
    );
    const notMembers = decisions.flatMap((decision) => {
      if (decision.allowed) return [];
      const user = users.find((u) => u.id === decision.userId);
      return [{ login: user?.githubLogin ?? null, reason: decision.reason }];
    });
    const notice = buildImportNotice({
      at: timestamp,
      memberCount: members,
      notMembers,
      neverSignedIn: [...legacy.access.logins].filter(
        (login) => !loginsWithUsers.has(login),
      ),
      organization: legacy.access.org,
      notImported: groupOf(legacy, env),
      oauthApp: legacy.oauthApp,
      invalidLoginEntries:
        legacy.access.invalidLoginEntries.length +
        legacy.access.invalidPresetEntries,
    });
    const hasNotice = noticeHasContent(notice);
    if (hasNotice) await instance.set("import_notice", notice, null);
    await step("notice");
    await instance.set("import_state", "done", null);

    const result: ImportSummary = {
      members,
      notMembers: notMembers.length,
      usersMarked,
      githubApp,
      llmKey: llm.key,
      llmModel: llm.model,
      notice: hasNotice,
    };
    return result;
  });

  if (summary === null)
    return {
      kind: "not_needed",
      reason: "already_imported",
      importedBefore: true,
    };
  logSummary(log, summary, legacy);
  return { kind: "imported", summary };
}

async function importGithubApp({
  trx,
  legacy,
  appSecret,
  now,
}: {
  trx: Kysely<Database>;
  legacy: LegacyEnvironment;
  appSecret: string;
  now: () => Date;
}): Promise<ImportSummary["githubApp"]> {
  const { github } = legacy;
  if (github.kind === "absent") return "absent";
  if (github.kind === "unusable") return "not_usable";
  const settings = createInstanceSettingsRepository(trx, now);
  // Never over an App the admin saved.
  if ((await settings.get("github_app")) !== undefined)
    return "already_configured";
  const secrets = createSecretStore({ db: trx, appSecret, now });
  for (const [name, value] of [
    [PRIVATE_KEY_SECRET, github.privateKey],
    [WEBHOOK_SECRET, github.webhookSecret],
  ] as const) {
    const saved = await secrets.save(name, value, { updatedBy: null });
    // Both passed the rules of the store when the environment was read; a refusal here is a bug, and it must
    // not leave half an App behind. The name of the secret, never its value.
    if (!saved.ok) throw new Error(`The secret ${name} was refused.`);
  }
  // No client secret: the App's user authorization is entered by the admin (the OAuth app of the earlier
  // sign in is a different thing and is not imported).
  await secrets.remove(CLIENT_SECRET);
  await settings.set(
    "github_app",
    {
      appId: github.appId,
      slug: github.slug,
      clientId: null,
      // GitHub's API does not say whether an App can only be installed on its own account: the admin confirms.
      privateApp: null,
      origin: "import",
    },
    null,
  );
  return "imported";
}

async function importLlm({
  trx,
  legacy,
  workspaceId,
  appSecret,
  now,
}: {
  trx: Kysely<Database>;
  legacy: LegacyEnvironment;
  workspaceId: string;
  appSecret: string;
  now: () => Date;
}): Promise<{
  key: ImportSummary["llmKey"];
  model: ImportSummary["llmModel"];
}> {
  const { llm } = legacy;
  if (llm.kind === "absent") return { key: "absent", model: "not_needed" };
  if (llm.kind === "unusable")
    return { key: "not_usable", model: "not_needed" };

  const keys = createWorkspaceLlmKeyService({
    store: createWorkspaceSecretStore({ db: trx, workspaceId, appSecret, now }),
  });
  let key: ImportSummary["llmKey"] = "already_configured";
  // Never over a key the workspace has.
  if ((await keys.status()).state === "not_configured") {
    const saved = await keys.save(
      { provider: llm.provider, apiKey: llm.apiKey },
      null,
    );
    if (!saved.ok) throw new Error("The LLM key was refused.");
    key = "imported";
  }

  let model: ImportSummary["llmModel"] = "not_needed";
  if (llm.model !== null) {
    const defaults = createAppSettingsRepository(trx, workspaceId, now);
    const stored = await defaults.get(REVIEW_DEFAULTS_KEY);
    const current = parseStoredOverrides(stored?.value);
    if (current.model === undefined) {
      await defaults.set(
        REVIEW_DEFAULTS_KEY,
        { ...current, model: llm.model },
        null,
      );
      model = "imported";
    }
  }
  return { key, model };
}

function logSummary(
  log: ImportLog,
  summary: ImportSummary,
  legacy: LegacyEnvironment,
): void {
  log.info(
    `[import] IMPORT_DONE: this installation was imported into the default workspace: ${String(summary.usersMarked)} users marked as imported, ${String(summary.members)} made members, ${String(summary.notMembers)} not made members, GitHub App ${describe(summary.githubApp)}, LLM key ${describe(summary.llmKey)}. The instance is not set up yet: finish the short setup with the code below.`,
  );
  if (legacy.github.kind === "unusable")
    log.warn(
      `[import] VARIABLE_NOT_IMPORTED: the GitHub App was not imported, ${legacy.github.variables.join(", ")} ${legacy.github.problem === "missing" ? "not set" : "not usable"}. Enter the App in the admin portal under Integrations.`,
    );
  if (legacy.llm.kind === "unusable")
    log.warn(
      `[import] VARIABLE_NOT_IMPORTED: the LLM key was not imported, ${legacy.llm.variables.join(", ")} not usable. Enter the key in the workspace settings, LLM access.`,
    );
  if (legacy.oauthApp)
    log.info(
      "[import] OAUTH_APP_NOT_IMPORTED: GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are no longer used. Sign in with GitHub is enabled in the admin portal with the client id and secret of the GitHub App.",
    );
}

function describe(value: string): string {
  return value.replaceAll("_", " ");
}
