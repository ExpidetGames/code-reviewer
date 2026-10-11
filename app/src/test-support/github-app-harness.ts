// SPDX-License-Identifier: Apache-2.0

// The fake GitHub (src/test-support/github-fake.ts) together with the GitHub App environment that
// points at it, for tests of the GitHub client, the provider and the sync.
import type { FakeGithub } from "../../../fakes/github/server.ts";
import { testGithubAppEnv } from "./github-app.ts";
import { startTestGithub } from "./github-fake.ts";

export type GithubAppHarness = {
  fake: FakeGithub;
  /** The GitHub App variables, with the API base URL set to the fake. */
  env: Record<string, string | undefined>;
  /** One clock for the fake and the code under test; move it with `advance`. */
  clock: { now(): number; advance(ms: number): void };
};

export async function startGithubAppHarness(
  options: {
    /**
     * The fake GitHub to use. Default: a new one (`startTestGithub`) that runs on this harness's
     * clock; a fake passed in keeps its own clock, so `clock.advance` does not move it.
     */
    fake?: FakeGithub;
  } = {},
): Promise<GithubAppHarness> {
  let nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
  const clock = {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const fake = options.fake ?? (await startTestGithub({ now: clock.now }));
  return {
    fake,
    clock,
    env: testGithubAppEnv({
      GITHUB_API_BASE_URL: fake.baseUrl,
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    }),
  };
}
