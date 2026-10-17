// SPDX-License-Identifier: Apache-2.0

// What the pages may know about the instance's configuration: whether the GitHub App and the LLM defaults
// work and, if not, what is wrong. Only names and stable codes, never a value (the private key, the webhook
// secret and the LLM key are secrets, and a wrong value may be a secret pasted into the wrong place). Pure:
// the GitHub snapshot (src/github-config/) and the environment are passed in.
import type { GithubSnapshot } from "../github-config/credentials.ts";
import { githubAppInstallUrlFor } from "../integrations/registry.ts";
import { readLlmDefaults } from "../llm/config.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import type { LlmStatus } from "../llm/status.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GithubAppStatus =
  | { configured: true; slug: string }
  | {
      configured: false;
      /** `missing`: not set. `invalid`: set but not usable. */
      kind: "missing" | "invalid";
      /** Names of settings (`github_app_private_key`), never values. */
      variables: readonly string[];
      /** The app's URL name when it is known and well formed, for the install link; otherwise null. */
      slug: string | null;
    };

export type ConfigStatus = {
  githubApp: GithubAppStatus;
  llm: LlmStatus;
};

/** The GitHub part of the status from the credentials as the server reads them. */
export function githubAppStatusOf(snapshot: GithubSnapshot): GithubAppStatus {
  if (snapshot.app.ok)
    return { configured: true, slug: snapshot.app.config.slug };
  return {
    configured: false,
    kind: snapshot.app.kind,
    variables: snapshot.app.fields,
    slug: snapshot.slug,
  };
}

/** The install address of the App (github.com/apps/<slug>/installations/new), or null while its slug is not known. */
export function installUrlOf(status: GithubAppStatus): string | null {
  return status.slug === null ? null : githubAppInstallUrlFor(status.slug);
}

/**
 * The LLM part: the key is a matter of each workspace (src/llm/), so the instance has nothing to report about
 * one; what it has is the built-in model and the options of `LLM_MODEL` and `LLM_MAX_TOKENS`, and a wrong one is
 * a warning. (`LLM_PROVIDER` and `LLM_API_KEY` of an installation from before accounts were imported once and
 * are not read.)
 */
function llmStatusOf(env: Env): LlmStatus {
  const defaults = readLlmDefaults(env);
  return {
    configured: true,
    provider: DEFAULT_LLM_PROVIDER,
    model: defaults.model,
    warnings: defaults.warnings,
  };
}

/**
 * `github` is the status the server read from the credentials (`githubAppStatusOf`); the environment only
 * holds the LLM defaults (`LLM_MODEL`, `LLM_MAX_TOKENS`).
 */
export function describeConfigStatus(
  env: Env,
  github: GithubAppStatus,
): ConfigStatus {
  return {
    githubApp: github,
    llm: llmStatusOf(env),
  };
}

/**
 * Who a page about the configuration is shown to. The configuration of the instance (which variables are
 * missing, what the provider and the model are) is the business of the person who runs the instance; the
 * members of a workspace, who may be people of another organization on a shared instance, only learn whether
 * a part works.
 */
export type ConfigAudience = "operator" | "member";

/** The audience of a person: the instance admin is the operator, everybody else a member. */
export function configAudienceOf(user: {
  isInstanceAdmin: boolean;
}): ConfigAudience {
  return user.isInstanceAdmin ? "operator" : "member";
}

/**
 * The status with nothing of the operator's configuration left in it: whether the GitHub App works, and no
 * variable name, slug, provider, model or warning. What a member's page gets, so the names are not in the
 * data of the page at all (and the copy for a member does not read them either).
 */
export function statusForMembers(status: ConfigStatus): ConfigStatus {
  return {
    githubApp: status.githubApp.configured
      ? { configured: true, slug: "" }
      : { configured: false, kind: "missing", variables: [], slug: null },
    llm: {
      configured: true,
      provider: DEFAULT_LLM_PROVIDER,
      model: "",
      warnings: [],
    },
  };
}
