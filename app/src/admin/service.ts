// SPDX-License-Identifier: Apache-2.0

// The instance settings service of the admin portal (docs/decisions/0001-editions-setup-and-
// accounts.md, sections 2.3 and 2.7): typed reads and writes of the instance-level settings (tenancy,
// sign-up rule, ways to sign in, limits). Every write is validated, goes through the rules of the
// decision record, and records the admin and the time in `instance_settings`. The secrets appear only
// as their status (configured, or cannot be read), never as a value.
import type { Kysely } from "kysely";
import {
  createInstanceSettingsRepository,
  type ReadableSettingKey,
  type InstanceSettingValues,
} from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type {
  SmtpConfigStore,
  SmtpPasswordState,
} from "../mail/smtp-config.ts";
import type { SmtpSettings } from "../mail/smtp-settings.ts";
import type { TestMailResult, TestMailService } from "../mail/test-mail.ts";
import { checkLlmApiKey, type LlmProvider } from "../llm/config.ts";
import {
  createOperatorLlmKeyService,
  type OperatorLlmKeyStatus,
} from "../llm/operator-key.ts";
import type { OperatorKeyTestService } from "../llm/operator-key-test.ts";
import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "../llm/providers/index.ts";
import type { LlmKeyTestResult } from "../llm/key-test.ts";
import type { OperatorProviderLookup } from "../llm/workspace-key.ts";
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
import type { CatalogSummary } from "../model-catalog/service.ts";
import { savePlanManagementUrl } from "../plan-handoff/settings.ts";
import { checkPlanManagementUrl } from "../plan-handoff/url.ts";
import {
  checkOwnKeyTokenCap,
  ownKeyTokenCapOf,
} from "../native-cost/token-cap.ts";
import { githubIdentityLinked } from "./github-identity.ts";
import { parseOperatorKeyChange } from "./operator-key-change.ts";
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
   * #553: the most tokens a Dynamic run on a workspace's own key may use when the price of its model is not known. The
   * default until saved; a saved value is within the bounds of `token-cap.ts`.
   */
  ownKeyTokenCap: SettingView<number>;
  /**
   * #195/#202 rollout gate: whether Dynamic Review may be queued. Off until an admin turns it on; turning
   * it off cancels the waiting Dynamic jobs and leaves the running ones (contracts/README.md).
   */
  dynamicReview: SettingView<boolean>;
  /**
   * #284: the operator-configured page "Manage plan" hands an Owner or Admin over to (src/plan-handoff/); null while
   * there is none, and then there is no button and no route. A saved value that is no longer valid reads as null.
   */
  planManagementUrl: SettingView<string | null>;
  /**
   * The mail server (null: none). The password is never part of it: `password` says whether one is set, and
   * whether it can still be read.
   */
  smtp: SettingView<SmtpSettings | null> & { password: SmtpPasswordState };
  /**
   * The operator's own LLM key of each provider (#276, #427), by the provider's id, in the order of the registry:
   * whether it is configured, cannot be read, or is missing, and the last four characters of a long key. Never a key.
   */
  operatorLlmKeys: Record<string, OperatorLlmKeyStatus>;
  /**
   * The state of the key of the default provider, as before there were several providers. Kept for one more
   * release for whoever reads it; `operatorLlmKeys` is the field to use.
   */
  operatorLlmKey: OperatorLlmKeyStatus;
  /**
   * #429: how many catalog entries are released for each kind and whether the kind has a default: numbers and nothing
   * else, so the overview shows no name, provider or model.
   */
  modelCatalog: CatalogSummary;
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
  /** `value` is the request's `ownKeyTokenCap` as received: a whole number of tokens within the bounds of `token-cap.ts`. */
  changeOwnKeyTokenCap(actorId: string, value: unknown): Promise<ChangeResult>;
  /**
   * `change` is the request's `dynamicReview` value as received: `{ enabled: boolean }`. It goes through the
   * instance settings repository, which takes the gate lock and cancels the waiting Dynamic jobs on off.
   */
  changeDynamicReview(actorId: string, change: unknown): Promise<ChangeResult>;
  /**
   * `value` is the request's `planManagementUrl` as received: an absolute `https:` address (no credentials, no
   * fragment), or null to remove the page.
   */
  changePlanManagementUrl(
    actorId: string,
    value: unknown,
  ): Promise<ChangeResult>;
  /** `smtp` is the request's `smtp` value as received: an object to save, or null to remove the mail server. */
  changeSmtp(actorId: string, smtp: unknown): Promise<ChangeResult>;
  /**
   * `change` is the request's `operatorLlmKey` value as received: `{ apiKey }` to save the operator's own LLM
   * key (write-only), or null to remove it.
   */
  changeOperatorLlmKey(actorId: string, change: unknown): Promise<ChangeResult>;
  /**
   * `change` is the request's `operatorLlmKeys` value as received: `{ <provider>: { apiKey } | null }`, the key of
   * one provider to save (write-only) or to remove. The keys of the other providers are not touched.
   */
  changeOperatorLlmKeys(
    actorId: string,
    change: unknown,
  ): Promise<ChangeResult>;
  /**
   * The Test button of one provider's key: `apiKey` is the request's value as received (empty or missing: the
   * stored key of that provider). The provider is a registered id, which the route has settled. Limited per admin and
   * for the instance, with counters of its own; counters that cannot be read throw.
   */
  testOperatorLlmKey(
    actorId: string,
    input: { provider: string; apiKey: unknown },
  ): Promise<OperatorKeyTestAnswer>;
  /** Sends the test mail to the acting admin's own address. */
  sendTestMail(actor: { id: string; email: string }): Promise<TestMailResult>;
  /** Hides the notice of the import. A notice that is not there is not an error. */
  dismissImportNotice(actorId: string): Promise<ChangeResult>;
};

/** What the Test button answers: the class of the result, or the issue with the typed key. */
export type OperatorKeyTestAnswer = LlmKeyTestResult | InvalidInput;

export type AdminServiceOptions = {
  db: Kysely<Database>;
  secrets: SecretStore;
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
  /** The Test button of the operator's keys (src/llm/operator-key-test.ts). */
  operatorKeyTest: OperatorKeyTestService;
  /** The numbers of the model catalog for the overview (src/model-catalog/service.ts, #429). */
  catalogSummary: () => Promise<CatalogSummary>;
  /** The providers the app supports; a test passes its own. */
  providers?: OperatorProviderLookup;
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

/** The saved page, or null when none is saved or what is saved is not a valid page (the reader fails closed). */
function checkedPlanManagementUrl(value: unknown): string | null {
  if (value === undefined) return null;
  const checked = checkPlanManagementUrl(value);
  return checked.ok ? checked.url : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAdminService({
  db,
  secrets,
  smtp,
  testMail,
  operatorKeyTest,
  catalogSummary,
  providers = llmProviderDescriptors,
  githubConfigured,
  mailConfigured,
  now = () => new Date(),
}: AdminServiceOptions): AdminService {
  const settings = createInstanceSettingsRepository(db, now);
  const operatorKey = createOperatorLlmKeyService({
    store: secrets,
    providers,
  });

  async function changeOperatorKey(
    actorId: string,
    setting: "operatorLlmKey" | "operatorLlmKeys",
    value: unknown,
  ): Promise<ChangeResult> {
    const parsed = parseOperatorKeyChange(setting, value, providers);
    if (!parsed.ok)
      return { ok: false, error: "invalid_input", issues: parsed.issues };
    if (parsed.change === null) {
      await operatorKey.remove(parsed.provider);
      return { ok: true };
    }
    const saved = await operatorKey.save(
      { provider: parsed.provider, apiKey: parsed.change.apiKey },
      actorId,
    );
    if (!saved.ok)
      return { ok: false, error: "invalid_input", issues: saved.issues };
    return { ok: true };
  }

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
      const operatorStatuses = await operatorKey.statusAll();
      const keys: ReadableSettingKey[] = [
        "tenancy",
        "sign_up_rule",
        "sign_in_methods",
        "max_workspaces_per_user",
        "own_key_max_total_tokens",
        "setup_completed_at",
        "import_notice",
        "dynamic_review",
        "plan_management_url",
      ];
      const [
        tenancy,
        rule,
        methods,
        maxWorkspaces,
        ownKeyTokenCap,
        completed,
        notice,
        dynamicReview,
        planManagementUrl,
      ] = await Promise.all(keys.map((key) => settings.getWithMeta(key)));
      const importNotice = readImportNotice(notice?.value);
      const mailServer = await smtp.view();
      const ids = [
        tenancy?.updatedBy,
        rule?.updatedBy,
        methods?.updatedBy,
        maxWorkspaces?.updatedBy,
        ownKeyTokenCap?.updatedBy,
        dynamicReview?.updatedBy,
        planManagementUrl?.updatedBy,
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
      const workspaceCount = await createWorkspacesRepository(db).count();

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
        ownKeyTokenCap: view(
          ownKeyTokenCap,
          ownKeyTokenCapOf(ownKeyTokenCap?.value),
        ),
        dynamicReview: view(
          dynamicReview,
          (dynamicReview?.value as { enabled: boolean } | undefined)
            ?.enabled === true,
        ),
        planManagementUrl: view(
          planManagementUrl,
          checkedPlanManagementUrl(planManagementUrl?.value),
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
        operatorLlmKeys: Object.fromEntries(
          operatorStatuses.map(({ provider, status }) => [provider, status]),
        ),
        operatorLlmKey: operatorStatuses.find(
          ({ provider }) => provider === DEFAULT_LLM_PROVIDER,
        )?.status ?? { state: "not_configured" },
        modelCatalog: await catalogSummary(),
        workspaceCount: workspaceCount,
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

    async changePlanManagementUrl(actorId, value) {
      const saved = await savePlanManagementUrl(settings, value, actorId);
      if (saved.ok) return { ok: true };
      return {
        ok: false,
        error: "invalid_input",
        issues: [{ field: "planManagementUrl", code: saved.code }],
      };
    },

    async changeSmtp(actorId, value) {
      if (value === null) {
        await smtp.remove();
        return { ok: true };
      }
      return smtp.save(actorId, value);
    },

    changeOperatorLlmKey: (actorId, change) =>
      changeOperatorKey(actorId, "operatorLlmKey", change),

    changeOperatorLlmKeys: (actorId, change) =>
      changeOperatorKey(actorId, "operatorLlmKeys", change),

    async testOperatorLlmKey(actorId, input) {
      // A key typed into the field is checked as it is (and forgotten); with an empty field the stored key of this
      // provider is.
      const { apiKey: typedValue } = input;
      const typed =
        typedValue !== undefined &&
        typedValue !== null &&
        !(typeof typedValue === "string" && typedValue.trim() === "");
      let apiKey: string;
      if (typed) {
        const checked =
          typeof typedValue === "string"
            ? checkLlmApiKey(typedValue)
            : { ok: false as const };
        if (!checked.ok)
          return {
            ok: false,
            error: "invalid_input",
            issues: [{ field: "apiKey", code: "api_key_invalid" }],
          };
        apiKey = checked.key;
      } else {
        const stored = await operatorKey.forJob(input.provider);
        if (stored.state !== "key")
          return {
            ok: false,
            error: "invalid_input",
            issues: [
              {
                field: "apiKey",
                // A key that is there but cannot be read is not a missing key: the admin must enter it again.
                code:
                  stored.state === "unreadable"
                    ? "api_key_unreadable"
                    : "api_key_required",
              },
            ],
          };
        apiKey = stored.apiKey;
      }
      return operatorKeyTest.test({
        adminId: actorId,
        provider: input.provider as LlmProvider,
        apiKey,
      });
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

    async changeOwnKeyTokenCap(actorId, value) {
      const checked = checkOwnKeyTokenCap(value);
      if (!checked.ok)
        return {
          ok: false,
          error: "invalid_input",
          issues: [{ field: "ownKeyTokenCap", code: checked.code }],
        };
      await settings.set("own_key_max_total_tokens", checked.value, actorId);
      return { ok: true };
    },
  };
}
