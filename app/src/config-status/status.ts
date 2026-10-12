// SPDX-License-Identifier: Apache-2.0

// What the pages may know about the instance's configuration: whether the GitHub App settings and
// the LLM access work and, if not, which variables are wrong. Only names and stable codes, never a
// value (the private key, the webhook secret and the LLM key are secrets, and a wrong value may be a
// secret pasted into the wrong variable). Pure: the environment is passed in.
import {
  describeGithubAppSetup,
  githubAppInstallUrl,
  type GithubAppSetup,
} from "../integrations/registry.ts";
import { loadLlmConfig } from "../llm/config.ts";
import { describeLlmStatus, type LlmStatus } from "../llm/status.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type GithubAppStatus = GithubAppSetup;

export type ConfigStatus = {
  githubApp: GithubAppStatus;
  llm: LlmStatus;
};

export { githubAppInstallUrl };

export function describeConfigStatus(env: Env): ConfigStatus {
  return {
    githubApp: describeGithubAppSetup(env),
    llm: describeLlmStatus(loadLlmConfig(env)),
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
 * The status with nothing of the operator's configuration left in it: whether the GitHub App and the LLM
 * access work, and no variable name, slug, provider, model or warning. What a member's page gets, so the names
 * are not in the data of the page at all (and the copy for a member does not read them either).
 */
export function statusForMembers(status: ConfigStatus): ConfigStatus {
  return {
    githubApp: status.githubApp.configured
      ? { configured: true, slug: "" }
      : { configured: false, kind: "missing", variables: [], slug: null },
    llm: status.llm.configured
      ? { configured: true, provider: "openrouter", model: "", warnings: [] }
      : { configured: false, issues: [], warnings: [] },
  };
}
