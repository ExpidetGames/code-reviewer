// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the secret store on the server's database, with the master key
// from the environment. Server code only.
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { getDatabase } from "../db/startup.ts";
import { createSecretStore, type SecretStore } from "./store.ts";

export function getSecretStore(): SecretStore {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return createSecretStore({ db: getDatabase(), appSecret: resolved.secret });
}
