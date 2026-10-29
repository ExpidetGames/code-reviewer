// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the secret store on the server's database, with the master key
// from the environment. The caller says which names the store knows. Server code only.
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { getDatabase } from "../db/startup.ts";
import { createSecretStore, type SecretStore } from "./store.ts";

export function getSecretStore<Name extends string>(
  names: readonly Name[],
): SecretStore<Name> {
  return getSecretStoreOn(getDatabase(), names);
}

/** The same store on a given executor: a transaction, when a secret must change together with a setting. */
export function getSecretStoreOn<Name extends string>(
  executor: Kysely<Database>,
  names: readonly Name[],
): SecretStore<Name> {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return createSecretStore({ db: executor, names, appSecret: resolved.secret });
}
