// SPDX-License-Identifier: Apache-2.0

// The instance settings service of the admin portal (docs/decisions/0001-editions-setup-and-
// accounts.md, sections 2.3 and 2.7): typed reads and writes of the instance-level settings (tenancy,
// sign-up rule, ways to sign in, limits). Every write is validated, goes through the rules of the
// decision record, and records the admin and the time in `instance_settings`. The secrets appear only
// as their status (configured, or cannot be read), never as a value.
import type { Kysely } from "kysely";
import {
  createInstanceSettingsRepository,
  type InstanceSettingKey,
  type InstanceSettingValues,
} from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type {
  SmtpConfigStore,
  SmtpPasswordState,
} from "../mail/smtp-config.ts";
import type { SmtpSettings } from "../mail/smtp-settings.ts";
import type { TestMailResult, TestMailService } from "../mail/test-mail.ts";
import type { SecretStatus, SecretStore } from "../secrets/store.ts";
import type { SetupIssue } from "../setup/errors.ts";
import { parseSignUpRule } from "../setup/input.ts";
import { CLOSED_RULE } from "../signup/rule.ts";
import {
  DEFAULT_MAX_WORKSPACES_PER_USER,
  MAX_WORKSPACES_PER_USER,
  MIN_WORKSPACES_PER_USER,
} from "../workspaces/limits.ts";
import {
  readImportNotice,
  type ImportNotice,
} from "../legacy-import/notice.ts";
import { githubIdentityLinked } from "./github-identity.ts";
import {
  checkSignInMethods,
  effectiveSignInMethods,
  type SignInMethods,
  type SignInMethodsErrorCode,
} from "./sign-in-methods.ts";
import { signUpRuleState, type SignUpRuleState } from "./sign-up-rule-state.ts";
import {
  changeTenancy,
  DEFAULT_TENANCY,
  type ChangeTenancyResult,
  type Tenancy,
} from "./tenancy.ts";

export {
  DEFAULT_MAX_WORKSPACES_PER_USER,
  MAX_WORKSPACES_PER_USER,
  MIN_WORKSPACES_PER_USER,
};

type SignUpRule = InstanceSettingValues["sign_up_rule"];

/** A setting as the portal shows it: the value, and who saved it and when (null: never saved). */
export type SettingView<T> = {
  value: T;
  updatedBy: { id: string; email: string | null } | null;
  updatedAt: string | null;
};

export type AdminSettingsView = {
  tenancy: SettingView<Tenancy>;
  /** Nothing saved reads as a rule that lets nobody sign up. */
  signUpRule: SettingView<SignUpRule>;
  signInMethods: SettingView<SignInMethods> & {
    /** What is actually on, given whether GitHub is configured. */
    effective: SignInMethods;
  };
  maxWorkspacesPerUser: SettingView<number>;
  /**
   * #195/#202 rollout gate: whether Dynamic Review may be queued. Off until an admin turns it on; turning
   * it off cancels the waiting Dynamic jobs and leaves the running ones (contracts/README.md).
   */
  dynamicReview: SettingView<boolean>;
  /**
   * The mail server (null: none). The password is never part of it: `password` says whether one is set, and
   * whether it can still be read.
   */
  smtp: SettingView<SmtpSettings | null> & { password: SmtpPasswordState };
  workspaceCount: number;
  githubConfigured: boolean;
  mailConfigured: boolean;
  signUpRuleState: SignUpRuleState;
  /** The status of every secret of the instance: never a value. */
  secrets: SecretStatus[];
  /** ISO 8601 time the first-run setup finished, or null. */
  setupCompletedAt: string | null;
  /**
   * What the import of an existing installation could not migrate, until the admin dismisses it; null when
   * there is nothing to tell or it was dismissed (src/legacy-import/).
   */
  importNotice: ImportNotice | null;
};

export type InvalidInput = {
  ok: false;
  error: "invalid_input";
  issues: SetupIssue[];
};
export type ChangeResult = { ok: true } | InvalidInput;
export type ChangeSignInMethodsResult =
  { ok: true } | InvalidInput | { ok: false; error: SignInMethodsErrorCode };

export type AdminService = {
  readSettings(): Promise<AdminSettingsView>;
  changeTenancy(
    actorId: string,
    tenancy: Tenancy,
  ): Promise<ChangeTenancyResult>;
  /** `rule` is the request's `signUp` object, as received. */
  changeSignUpRule(actorId: string, rule: unknown): Promise<ChangeResult>;
  /** `methods` is the request's object, as received. */
  changeSignInMethods(
    actorId: string,
    methods: unknown,
  ): Promise<ChangeSignInMethodsResult>;
  changeLimits(
    actorId: string,
    limits: { maxWorkspacesPerUser: unknown },
  ): Promise<ChangeResult>;
  /**
   * `change` is the request's `dynamicReview` value as received: `{ enabled: boolean }`. It goes through the
   * instance settings repository, which takes the gate lock and cancels the waiting Dynamic jobs on off.
   */
  changeDynamicReview(actorId: string, change: unknown): Promise<ChangeResult>;
  /** `smtp` is the request's `smtp` value as received: an object to save, or null to remove the mail server. */
  changeSmtp(actorId: string, smtp: unknown): Promise<ChangeResult>;
  /** Sends the test mail to the acting admin's own address. */
  sendTestMail(actor: { id: string; email: string }): Promise<TestMailResult>;
  /** Hides the notice of the import. A notice that is not there is not an error. */
  dismissImportNotice(actorId: string): Promise<ChangeResult>;
};

export type AdminServiceOptions = {
  db: Kysely<Database>;
  secrets: Pick<SecretStore, "statuses">;
  /** Whether sign-in with GitHub can work: the GitHub App's user authorization is configured. */
  githubConfigured: () => boolean | Promise<boolean>;
  /**
   * Counts as "mail can be sent" in addition to the saved mail server (tests only; the running server leaves
   * it out, so the settings are read once).
   */
  mailConfigured?: () => Promise<boolean>;
  /** The stored mail server settings and password (src/mail/smtp-config.ts). */
  smtp: SmtpConfigStore;
  /** The test mail button (src/mail/test-mail.ts). */
  testMail: TestMailService;
  now?: () => Date;
};

/** Whether a message could be sent with the saved mail server: settings, and a password that can be read for a login. */
function canSend(view: {
  settings: { user: string | null } | null;
  password: string;
}): boolean {
  if (view.settings === null) return false;
  return view.settings.user === null || view.password === "configured";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAdminService({
  db,
  secrets,
  smtp,
  testMail,
  githubConfigured,
  mailConfigured,
  now = () => new Date(),
}: AdminServiceOptions): AdminService {
  const settings = createInstanceSettingsRepository(db, now);

  async function emailsOf(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("id", "in", ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row.email]));
  }

  return {
    async readSettings() {
      const keys: InstanceSettingKey[] = [
        "tenancy",
        "sign_up_rule",
        "sign_in_methods",
        "max_workspaces_per_user",
        "setup_completed_at",
        "import_notice",
        "dynamic_review",
      ];
      const [
        tenancy,
        rule,
        methods,
        maxWorkspaces,
        completed,
        notice,
        dynamicReview,
      ] = await Promise.all(keys.map((key) => settings.getWithMeta(key)));
      const importNotice = readImportNotice(notice?.value);
      const mailServer = await smtp.view();
      const ids = [
        tenancy?.updatedBy,
        rule?.updatedBy,
        methods?.updatedBy,
        maxWorkspaces?.updatedBy,
        dynamicReview?.updatedBy,
        mailServer.updatedBy,
      ].filter((id): id is string => typeof id === "string");
      const emails = await emailsOf([...new Set(ids)]);
      const view = <T>(
        meta: { updatedBy: string | null; updatedAt: string } | undefined,
        value: T,
      ): SettingView<T> => ({
        value,
        updatedBy:
          meta?.updatedBy == null
            ? null
            : { id: meta.updatedBy, email: emails.get(meta.updatedBy) ?? null },
        updatedAt: meta?.updatedAt ?? null,
      });

      const github = await githubConfigured();
      const mail = canSend(mailServer) || (await mailConfigured?.()) === true;
      const storedMethods = methods?.value as SignInMethods | undefined;
      const effective = effectiveSignInMethods(storedMethods, github);
      const signUp: SignUpRule =
        (rule?.value as SignUpRule | undefined) ?? CLOSED_RULE;
      const count = await db
        .selectFrom("workspaces")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();

      return {
        tenancy: view(
          tenancy,
          (tenancy?.value as Tenancy | undefined) ?? DEFAULT_TENANCY,
        ),
        signUpRule: view(rule, signUp),
        signInMethods: {
          ...view(methods, storedMethods ?? effective),
          effective,
        },
        maxWorkspacesPerUser: view(
          maxWorkspaces,
          (maxWorkspaces?.value as number | undefined) ??
            DEFAULT_MAX_WORKSPACES_PER_USER,
        ),
        dynamicReview: view(
          dynamicReview,
          (dynamicReview?.value as { enabled: boolean } | undefined)
            ?.enabled === true,
        ),
        smtp: {
          ...view(
            mailServer.updatedAt === null
              ? undefined
              : {
                  updatedBy: mailServer.updatedBy,
                  updatedAt: mailServer.updatedAt,
                },
            mailServer.settings,
          ),
          password: mailServer.password,
        },
        workspaceCount: Number(count.count),
        githubConfigured: github,
        mailConfigured: mail,
        signUpRuleState: signUpRuleState({
          rule: signUp,
          mailConfigured: mail,
          signInMethods: effective,
        }),
        secrets: await secrets.statuses(),
        setupCompletedAt:
          typeof completed?.value === "string" ? completed.value : null,
        importNotice:
          importNotice === null || importNotice.dismissedAt !== null
            ? null
            : importNotice,
      };
    },

    changeTenancy: (actorId, tenancy) =>
      changeTenancy(db, { actorId, tenancy, now }),

    async changeSignUpRule(actorId, rule) {
      const issues: SetupIssue[] = [];
      const parsed = parseSignUpRule(rule, issues);
      if (parsed === null || issues.length > 0)
        return { ok: false, error: "invalid_input", issues };
      await settings.set("sign_up_rule", parsed, actorId);
      return { ok: true };
    },

    async changeSignInMethods(actorId, methods) {
      if (
        !isObject(methods) ||
        typeof methods.emailPassword !== "boolean" ||
        typeof methods.github !== "boolean"
      )
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "signInMethods", code: "sign_in_methods_invalid" }],
        };
      const wanted: SignInMethods = {
        emailPassword: methods.emailPassword,
        github: methods.github,
      };
      const checked = checkSignInMethods(wanted, {
        githubConfigured: await githubConfigured(),
        actorHasGithubIdentity: await githubIdentityLinked(db, actorId),
      });
      if (!checked.ok) return checked;
      await settings.set("sign_in_methods", wanted, actorId);
      return { ok: true };
    },

    async changeDynamicReview(actorId, change) {
      if (!isObject(change) || typeof change.enabled !== "boolean")
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "dynamicReview", code: "dynamic_review_invalid" }],
        };
      await settings.set(
        "dynamic_review",
        { enabled: change.enabled },
        actorId,
      );
      return { ok: true };
    },

    async changeSmtp(actorId, value) {
      if (value === null) {
        await smtp.remove();
        return { ok: true };
      }
      return smtp.save(actorId, value);
    },

    sendTestMail: (actor) => testMail.send(actor),

    async dismissImportNotice(actorId) {
      const stored = readImportNotice(await settings.get("import_notice"));
      if (stored === null || stored.dismissedAt !== null) return { ok: true };
      await settings.set(
        "import_notice",
        { ...stored, dismissedAt: now().toISOString() },
        actorId,
      );
      return { ok: true };
    },

    async changeLimits(actorId, limits) {
      const value = limits.maxWorkspacesPerUser;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < MIN_WORKSPACES_PER_USER ||
        value > MAX_WORKSPACES_PER_USER
      )
        return {
          ok: false,
          error: "invalid_input",
          issues: [
            { field: "maxWorkspacesPerUser", code: "number_out_of_range" },
          ],
        };
      await settings.set("max_workspaces_per_user", value, actorId);
      return { ok: true };
    },
  };
}
