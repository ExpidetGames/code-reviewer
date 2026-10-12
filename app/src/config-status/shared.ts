// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the configuration as the process environment has it right now.
// Read on every call, never cached, so a fixed variable shows on the next page load.
import "server-only";
import {
  configAudienceOf,
  describeConfigStatus,
  githubAppInstallUrl,
  statusForMembers,
  type ConfigStatus,
} from "./status.ts";

export function getConfigStatus(): ConfigStatus {
  return describeConfigStatus(process.env);
}

export function getGithubAppInstallUrl(): string | null {
  return githubAppInstallUrl(process.env);
}

/**
 * The status for the person who looks at the page: complete for the instance admin, only whether each part
 * works for everybody else (`statusForMembers`).
 */
export function getConfigStatusFor(user: {
  isInstanceAdmin: boolean;
}): ConfigStatus {
  const status = getConfigStatus();
  return configAudienceOf(user) === "operator"
    ? status
    : statusForMembers(status);
}
