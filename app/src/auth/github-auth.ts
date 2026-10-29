// SPDX-License-Identifier: LicenseRef-Proprietary

// The Better Auth instance that serves the sign in with GitHub on the running server. The client id and
// secret of the GitHub App's user authorization are read from the database every time a GitHub sign in
// starts or comes back, and the instance is kept only for as long as they are the same: when the admin
// replaces them it is made again, so the new ones count from the next sign in on every app instance. It
// shares the database and the master key with the instance of everything else (`getAuth`).
import "server-only";
import { createHash } from "node:crypto";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import { createGithubSignInDecider } from "../github-signin/decider.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { CODE_REVIEW_COM } from "../product-identity/code-review-com.ts";
import { readSignUpFacts } from "../signup/state.ts";
import { createAuth, type Auth } from "./auth.ts";
import { loadAuthConfig } from "./config.ts";

const globalKey = Symbol.for("code-reviewer.github-auth");
type GlobalWithGithubAuth = typeof globalThis & {
  [globalKey]?: { fingerprint: string; auth: Auth };
};

/** The instance for the GitHub sign in, or null while the user authorization is not configured. */
export async function getGithubAuth(): Promise<Auth | null> {
  const { userAuthorization } = await getGithubCredentialStore().load();
  if (userAuthorization.state !== "configured") return null;
  const clientSecret = userAuthorization.clientSecret.reveal();
  // Only a digest of the secret is kept as the key, so a secret is not the key of anything.
  const fingerprint = [
    userAuthorization.clientId,
    createHash("sha256").update(clientSecret).digest("hex"),
  ].join("\n");
  const holder = globalThis as GlobalWithGithubAuth;
  if (holder[globalKey]?.fingerprint !== fingerprint) {
    const db = getDatabase();
    holder[globalKey] = {
      fingerprint,
      auth: createAuth({
        db,
        config: loadAuthConfig(process.env),
        product: CODE_REVIEW_COM,
        githubSignIn: {
          clientId: userAuthorization.clientId,
          clientSecret,
          decide: createGithubSignInDecider({
            db,
            readFacts: () =>
              readSignUpFacts({
                db,
                mail: getMailSender(),
                // Asked because the GitHub sign in is configured.
                githubConfigured: () => true,
              }),
          }),
        },
        verificationRequired: () => getMailSender().isConfigured(),
      }),
    };
  }
  return holder[globalKey].auth;
}
