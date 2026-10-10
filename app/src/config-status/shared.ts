// The wiring of the running server: the configuration as the process environment has it right now.
// Read on every call, never cached, so a fixed variable shows on the next page load.
import "server-only";
import {
  describeConfigStatus,
  githubAppInstallUrl,
  type ConfigStatus,
} from "./status.ts";

export function getConfigStatus(): ConfigStatus {
  return describeConfigStatus(process.env);
}

export function getGithubAppInstallUrl(): string | null {
  return githubAppInstallUrl(process.env);
}
