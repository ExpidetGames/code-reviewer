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
