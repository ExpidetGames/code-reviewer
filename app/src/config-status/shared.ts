// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the configuration as the database and the process environment have it
// right now. Read on every call, never cached, so a fixed setting shows on the next page load.
import "server-only";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import {
  describeConfigStatus,
  githubAppStatusOf,
  installUrlOf,
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
