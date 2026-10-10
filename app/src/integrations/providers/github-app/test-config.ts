// A GithubAppConfig for tests of the provider folder, built from the dummy test environment.
import {
  testGithubAppEnv,
  TEST_APP_ID,
} from "../../../test-support/github-app.ts";
import { loadGithubAppConfig, type GithubAppConfig } from "./config.ts";

export { TEST_APP_ID };

export function testGithubAppConfig(
  overrides: Record<string, string | undefined> = {},
): GithubAppConfig {
  return loadGithubAppConfig(testGithubAppEnv(overrides));
}
