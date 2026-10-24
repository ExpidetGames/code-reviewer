// SPDX-License-Identifier: LicenseRef-Proprietary

// What the account page shows about the signed-in person: their address (and whether it is still the placeholder
// of an imported user, or collides with another account), and the GitHub account linked to theirs.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  readEmailState,
  readGithubIdentity,
  type GithubIdentityView,
} from "../github-config/facts.ts";
import { isPlaceholderEmail } from "../github-signin/decide.ts";

export type AccountView = {
  email: string;
  verified: boolean;
  /** The address is GitHub's placeholder for an imported user, replaced at the next GitHub sign in. */
  placeholder: boolean;
  /** GitHub's verified address that another account has already, when the placeholder could not be replaced. */
  emailConflict: string | null;
  identity: GithubIdentityView | null;
};

export async function loadAccount(
  db: Kysely<Database>,
  userId: string,
): Promise<AccountView | null> {
  const [state, identity] = await Promise.all([
    readEmailState(db, userId),
    readGithubIdentity(db, userId),
  ]);
  if (state === null) return null;
  return {
    email: state.email,
    verified: state.verified,
    placeholder: isPlaceholderEmail(state.email),
    emailConflict: state.conflict,
    identity,
  };
}
