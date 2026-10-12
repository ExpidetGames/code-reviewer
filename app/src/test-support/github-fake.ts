// SPDX-License-Identifier: Apache-2.0

// The one fake GitHub of the app's tests: it speaks the sign in (OAuth, user and organization
// lookups) and the GitHub App API on the same address, so a test of the login and a test of the
// GitHub integration use the same fake, and a test that needs both can use one instance. It is
// closed after the test. See fakes/github/README.md.
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import { TEST_APP_ID, testAppKeys } from "./github-app.ts";
import { cleanUpAfterTest } from "./test-database.ts";

/** The OAuth app the sign in tests register at the fake (dummy values). */
export const TEST_CLIENT_ID = "test-client-id";
export const TEST_CLIENT_SECRET = "test-client-secret-value";

export async function startTestGithub(
  options: {
    /** One clock for the fake and the code under test. Default: the real clock. */
    now?: () => number;
    /** The slug of the app registered at start (the bot is `<slug>[bot]`). Default: the fake's own. */
    appSlug?: string;
  } = {},
): Promise<FakeGithub> {
  const github = await startGithubFake({
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
    // Apps can be created through the manifest flow, next to the one registered at start.
    manifestFlow: true,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.appSlug === undefined ? {} : { appSlug: options.appSlug }),
  });
  cleanUpAfterTest(() => github.close());
  return github;
}
