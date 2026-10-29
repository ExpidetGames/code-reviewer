// SPDX-License-Identifier: LicenseRef-Proprietary

// The names of secrets are a closed list (docs/decisions/0001-editions-setup-and-accounts.md, section 2.7): the name is the
// row id of the `secrets` table and is bound into the ciphertext, so a name that changes makes a stored secret unreadable.
// This module knows none of them. The application declares its names (`src/secret-names/`, the LLM providers' own) and
// hands them to the store where it composes it (#715, cut 8); `composeSecretNames` joins the lists and refuses a name
// that two of them use, which would put two secrets under one row id.

export class SecretNamesError extends Error {
  readonly code = "secret_name_taken";

  constructor(name: string) {
    super(`secret_name_taken: "${name}" is the name of two secrets`);
    this.name = "SecretNamesError";
  }
}

/** The names of all the lists, each once, in alphabetical order. Throws `SecretNamesError` for a name two lists share. */
export function composeSecretNames<Name extends string>(
  ...lists: ReadonlyArray<readonly Name[]>
): readonly Name[] {
  const taken = new Set<Name>();
  for (const list of lists)
    for (const name of list) {
      if (taken.has(name)) throw new SecretNamesError(name);
      taken.add(name);
    }
  return [...taken].sort();
}
