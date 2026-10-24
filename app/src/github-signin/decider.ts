// SPDX-License-Identifier: LicenseRef-Proprietary

// The decision of a sign in with GitHub on the running instance: the pure rules (decide.ts) with the
// facts they rest on read when the person arrives, never remembered: who owns the GitHub identity, who
// has the address, the sign-up rule, whether the instance can send mail and which ways to sign in are on.
import type { Kysely } from "kysely";
import { signUpRuleState } from "../admin/sign-up-rule-state.ts";
import type { GithubProviderOptions } from "../auth/github-provider.ts";
import type { Database } from "../db/schema.ts";
import type { SignUpFacts } from "../signup/state.ts";
import { decideGithubSignIn } from "./decide.ts";
import { createIdentityDirectory } from "./directory.ts";

export function createGithubSignInDecider({
  db,
  readFacts,
}: {
  db: Kysely<Database>;
  /** The sign-up rule, the ways to sign in that are on and whether mail can be sent, read per sign in. */
  readFacts: () => Promise<SignUpFacts>;
}): GithubProviderOptions["decide"] {
  const directory = createIdentityDirectory(db);
  return async ({ githubId, emails }) => {
    const facts = await readFacts();
    const { failClosed } = signUpRuleState({
      rule: facts.rule,
      mailConfigured: facts.mailConfigured,
      signInMethods: facts.signInMethods,
    });
    return decideGithubSignIn({
      githubId,
      emails,
      directory,
      rule: facts.rule,
      failClosed,
    });
  };
}
