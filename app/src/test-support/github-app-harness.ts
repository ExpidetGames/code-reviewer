// A fake GitHub App API on a loopback port together with the environment that points at it, for
// tests of the GitHub client, the provider and the sync. The fake is closed after the test.
import { afterEach } from "vitest";
import {
  startGithubAppFake,
  type FakeGithubApp,
} from "../../../fakes/github/app-api.ts";
import { TEST_APP_ID, testAppKeys, testGithubAppEnv } from "./github-app.ts";

const open: FakeGithubApp[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});

export type GithubAppHarness = {
  fake: FakeGithubApp;
  /** The GitHub App variables, with the API base URL set to the fake. */
  env: Record<string, string | undefined>;
  /** One clock for the fake and the code under test; move it with `advance`. */
  clock: { now(): number; advance(ms: number): void };
};

export async function startGithubAppHarness(): Promise<GithubAppHarness> {
  let nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
  const clock = {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const fake = await startGithubAppFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
    now: clock.now,
  });
  open.push(fake);
  return {
    fake,
    clock,
    env: testGithubAppEnv({ GITHUB_API_BASE_URL: fake.baseUrl }),
  };
}
