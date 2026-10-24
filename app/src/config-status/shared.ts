// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the configuration as the database and the process environment have it
// right now. Read on every call, never cached, so a fixed setting shows on the next page load.
import "server-only";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import {
  configAudienceOf,
  describeConfigStatus,
  githubAppStatusOf,
  installUrlOf,
  statusForMembers,
  type ConfigStatus,
} from "./status.ts";

export async function getConfigStatus(): Promise<ConfigStatus> {
  const snapshot = await getGithubCredentialStore().load();
  return describeConfigStatus(process.env, githubAppStatusOf(snapshot));
}

export async function getGithubAppInstallUrl(): Promise<string | null> {
  return installUrlOf(
    githubAppStatusOf(await getGithubCredentialStore().load()),
  );
}

/**
 * The status for the person who looks at the page: complete for the instance admin, only whether each part
 * works for everybody else (`statusForMembers`).
 */
export async function getConfigStatusFor(user: {
  isInstanceAdmin: boolean;
}): Promise<ConfigStatus> {
  const status = await getConfigStatus();
  return configAudienceOf(user) === "operator"
    ? status
    : statusForMembers(status);
}
