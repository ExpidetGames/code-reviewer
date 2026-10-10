// Pins down that the check of the GitHub App settings is remembered for a short time, because it
// reads the key file and parses the key and the pages ask on every render: a changed variable counts
// at once, a key file replaced under the same path counts when the memory expires.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  testGithubAppEnv,
  testAppKeys,
} from "../../../test-support/github-app.ts";
import { createTestDirectory } from "../../../test-support/test-database.ts";
import {
  describeGithubAppSetup,
  forgetGithubAppSetup,
  SETUP_CACHE_MS,
} from "./setup-status.ts";

beforeEach(forgetGithubAppSetup);
afterEach(forgetGithubAppSetup);

async function envWithKeyFile() {
  const directory = await createTestDirectory();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "app.pem");
  writeFileSync(path, testAppKeys().privateKey);
  const env = testGithubAppEnv({
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_PRIVATE_KEY_PATH: path,
  });
  return { env, path };
}

describe("the remembered check of the GitHub App settings", () => {
  it("does not read the key file again while the memory holds", async () => {
    const { env, path } = await envWithKeyFile();
    let now = 1_000;
    expect(describeGithubAppSetup(env, () => now)).toMatchObject({
      configured: true,
    });

    writeFileSync(path, "not a key any more");
    now += SETUP_CACHE_MS - 1;

    expect(describeGithubAppSetup(env, () => now)).toMatchObject({
      configured: true,
    });
  });

  it("reads the key file again when the memory has expired", async () => {
    const { env, path } = await envWithKeyFile();
    let now = 1_000;
    describeGithubAppSetup(env, () => now);

    writeFileSync(path, "not a key any more");
    now += SETUP_CACHE_MS;

    expect(describeGithubAppSetup(env, () => now)).toMatchObject({
      configured: false,
      problem: "invalid",
      variables: ["GITHUB_APP_PRIVATE_KEY_PATH"],
    });
  });

  it("checks again at once when a variable changes", () => {
    const now = () => 1_000;
    expect(describeGithubAppSetup(testGithubAppEnv(), now)).toMatchObject({
      configured: true,
    });

    const result = describeGithubAppSetup(
      testGithubAppEnv({ GITHUB_APP_ID: undefined }),
      now,
    );

    expect(result).toMatchObject({
      configured: false,
      problem: "missing",
      variables: ["GITHUB_APP_ID"],
    });
  });
});
