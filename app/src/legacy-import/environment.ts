// SPDX-License-Identifier: Apache-2.0

// What the environment of an installation from before accounts says, read once for the import of that
// installation (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11). The only place that knows
// which variables are legacy. A variable that cannot be used is reported by NAME and never imported; no value
// ever goes into a result that is logged or stored: the secrets sit in a separate `secrets` object that only the
// transaction reads.
//
// Which variables are legacy:
//   - GITHUB_APP_ID, _SLUG, _PRIVATE_KEY (or _PRIVATE_KEY_PATH), _WEBHOOK_SECRET: the GitHub App, moved into the
//     encrypted store.
//   - LLM_PROVIDER and LLM_API_KEY: the shared key, moved into the default workspace. (LLM_MODEL is copied into
//     the workspace's review defaults when it differs from the built-in model, and stays what it was: the
//     built-in model of the instance. LLM_MAX_TOKENS stays an instance setting too.)
//   - ALLOWED_GITHUB_LOGINS and ALLOWED_GITHUB_ORG: read once to decide who becomes a member.
//   - GITHUB_OAUTH_CLIENT_ID and _SECRET: never imported (a GitHub OAuth app is not the GitHub App, its
//     client id and secret cannot be used for the App's sign in); only reported.
import {
  isUsableRsaKey,
  loadGithubAppConfig,
} from "../integrations/registry.ts";
import { GithubAppConfigError } from "../integrations/registry.ts";
import { parseAccessConfig, type AccessConfig } from "../auth/access-config.ts";
import {
  checkLlmApiKey,
  DEFAULT_LLM_MODEL,
  LLM_PROVIDERS,
  isModelId,
  type LlmProvider,
} from "../llm/config.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The legacy variables, in the order they are named in the log. */
export const LEGACY_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "ALLOWED_GITHUB_LOGINS",
  "ALLOWED_GITHUB_ORG",
  "LLM_PROVIDER",
  "LLM_API_KEY",
] as const;
export type LegacyVariable = (typeof LEGACY_VARIABLES)[number];

/** `LLM_PROVIDER` is passed on with a default by the compose files; it alone does not make a legacy key. */
function isSet(env: Env, name: LegacyVariable): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** The legacy variables that are set (names only), for the one log line that says they are ignored. */
export function setLegacyVariables(env: Env): LegacyVariable[] {
  const set = LEGACY_VARIABLES.filter((name) => isSet(env, name));
  // A provider on its own is the compose default, not a decision of the operator.
  const onlyProvider =
    set.length === 1 && set[0] === "LLM_PROVIDER" && !isSet(env, "LLM_API_KEY");
  return onlyProvider ? [] : set;
}

export type LegacyGithubApp =
  | { kind: "absent" }
  | {
      kind: "usable";
      appId: string;
      slug: string;
      privateKey: string;
      webhookSecret: string;
    }
  | {
      kind: "unusable";
      problem: "missing" | "invalid";
      /** Variable names, never values. */
      variables: string[];
    };

export type LegacyLlm =
  | { kind: "absent" }
  | {
      kind: "usable";
      provider: LlmProvider;
      apiKey: string;
      /** `LLM_MODEL` when it is set, valid and not the built-in one; otherwise null. */
      model: string | null;
    }
  | { kind: "unusable"; variables: string[] };

export type LegacyEnvironment = {
  /** The names of the legacy variables that are set. */
  setVariables: LegacyVariable[];
  github: LegacyGithubApp;
  llm: LegacyLlm;
  access: AccessConfig;
  /** An allowed GitHub organization is configured. */
  organization: string | null;
  /** The OAuth app of the earlier sign in was configured (never imported). */
  oauthApp: boolean;
  /** Secrets that must not appear in any log line, for the last line of defence. */
  secretValues: string[];
};

const APP_ID_PATTERN = /^[1-9]\d{0,19}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const WEBHOOK_SECRET_MAX_LENGTH = 512;
const PRIVATE_KEY_MAX_LENGTH = 16 * 1024;

function readGithub(env: Env): LegacyGithubApp {
  const anySet = (
    [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_APP_WEBHOOK_SECRET",
    ] as const
  ).some((name) => isSet(env, name));
  if (!anySet) return { kind: "absent" };
  let config;
  try {
    // The one loader the App has always been read with: it names what is missing or unusable.
    config = loadGithubAppConfig(env);
  } catch (error) {
    if (!(error instanceof GithubAppConfigError)) throw error;
    return {
      kind: "unusable",
      problem: error.problem,
      variables: [...error.variables],
    };
  }
  // The store has stricter rules than the loader (the id is a number, the lengths are bounded). A value it
  // would refuse is not imported, and its variable is named.
  const invalid: string[] = [];
  if (!APP_ID_PATTERN.test(config.appId)) invalid.push("GITHUB_APP_ID");
  if (!SLUG_PATTERN.test(config.slug)) invalid.push("GITHUB_APP_SLUG");
  if (
    config.webhookSecret.length > WEBHOOK_SECRET_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(config.webhookSecret)
  )
    invalid.push("GITHUB_APP_WEBHOOK_SECRET");
  if (
    config.privateKey.length > PRIVATE_KEY_MAX_LENGTH ||
    !isUsableRsaKey(config.privateKey)
  )
    invalid.push(
      isSet(env, "GITHUB_APP_PRIVATE_KEY")
        ? "GITHUB_APP_PRIVATE_KEY"
        : "GITHUB_APP_PRIVATE_KEY_PATH",
    );
  if (invalid.length > 0)
    return { kind: "unusable", problem: "invalid", variables: invalid };
  return {
    kind: "usable",
    appId: config.appId,
    slug: config.slug,
    privateKey: config.privateKey,
    webhookSecret: config.webhookSecret,
  };
}

function readLlm(env: Env): LegacyLlm {
  if (!isSet(env, "LLM_API_KEY")) return { kind: "absent" };
  const variables: string[] = [];
  const key = checkLlmApiKey(env.LLM_API_KEY);
  if (!key.ok) variables.push("LLM_API_KEY");
  const providerValue = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  const provider = LLM_PROVIDERS.find((known) => known === providerValue);
  if (provider === undefined) variables.push("LLM_PROVIDER");
  if (!key.ok || provider === undefined) return { kind: "unusable", variables };
  const model = (env.LLM_MODEL ?? "").trim();
  return {
    kind: "usable",
    provider,
    apiKey: key.key,
    model:
      model !== "" && model !== DEFAULT_LLM_MODEL && isModelId(model, provider)
        ? model
        : null,
  };
}

export function readLegacyEnvironment(env: Env): LegacyEnvironment {
  // The allow list is parsed leniently: what cannot be read is simply not an entry (it never admitted anybody).
  const access = parseAccessConfig(env, []);
  const github = readGithub(env);
  const llm = readLlm(env);
  const secretValues = [
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_APP_WEBHOOK_SECRET,
    env.GITHUB_OAUTH_CLIENT_SECRET,
    env.LLM_API_KEY,
    env.APP_SECRET,
    env.BETTER_AUTH_SECRET,
    env.RUNNER_TOKEN,
  ].filter((value): value is string => (value ?? "").trim() !== "");
  return {
    setVariables: setLegacyVariables(env),
    github,
    llm,
    access,
    organization: access.org,
    oauthApp:
      isSet(env, "GITHUB_OAUTH_CLIENT_ID") ||
      isSet(env, "GITHUB_OAUTH_CLIENT_SECRET"),
    secretValues,
  };
}
