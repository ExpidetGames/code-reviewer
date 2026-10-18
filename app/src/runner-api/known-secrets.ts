// SPDX-License-Identifier: Apache-2.0

// The exact secret values the app masks in a result it stores (see `redact.ts`): its own environment and the current
// keys of the job's workspace (#426: one per provider, plus the operator's while the workspace is managed).
import { knownSecretsFromEnv } from "./redact.ts";

export type KnownSecretsDeps = {
  env: Readonly<Record<string, string | undefined>>;
  currentKeysFor: (workspaceId: string) => Promise<readonly string[]>;
};

/**
 * Fails closed: if a key cannot be read, the error is thrown and the caller (the completion of a job) answers
 * `RUNNER_INTERNAL_ERROR` and stores nothing, so a result is never stored with less masking than it should have. A
 * key that exists but cannot be decrypted is not an error here (the key service answers `unreadable`, and the key
 * of the claim is masked from `claimed-keys.ts`); this is for a read that failed.
 */
export function createKnownSecrets(
  deps: KnownSecretsDeps,
): (workspaceId: string) => Promise<string[]> {
  return async (workspaceId) => [
    ...knownSecretsFromEnv(deps.env),
    ...(await deps.currentKeysFor(workspaceId)),
  ];
}
