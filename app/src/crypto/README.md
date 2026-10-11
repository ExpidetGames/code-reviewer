# Crypto

Small helpers around `APP_SECRET`, the master key of the instance
(`docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.1 and 2.7). Node's built-in `crypto`
only. Nothing here logs, and no error message contains a secret, a key or a ciphertext.

| File            | Role                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-secret.ts` | `resolveAppSecret(env)`: `APP_SECRET`, else `BETTER_AUTH_SECRET` (its deprecated name, logged once by `legacyAppSecretWarning`), at least 32 characters; otherwise one sentence naming the variable. |
| `keys.ts`       | `deriveKey(secret, purpose, version)`: HKDF-SHA256, one 32 byte key per purpose label (`setup-session`, `state-signing`, `secret-encryption`).                                                       |
| `sign.ts`       | `signValue` / `verifySignedValue`: HMAC-SHA256 of a value that travels through the browser, per-purpose key, constant time comparison. Integrity only: the value is readable.                        |
| `secret-box.ts` | `encryptSecret` / `decryptSecret`: AES-256-GCM, a random 96-bit nonce per encryption, the table, row id and field as additional authenticated data, the key version stored with the value.           |

- A ciphertext copied to another table, row or field does not decrypt (the AAD differs); neither does one
  made with another `APP_SECRET`, or one that was changed. All of these are `secret_undecryptable`
  (`SecretBoxError`), a stable error state, not a crash. An unknown key version is
  `secret_key_version_unknown`.
- A new use of the secret adds a purpose label to `KEY_PURPOSES`; it never reuses one.
- Better Auth is the one consumer that is given the secret itself (`auth.ts`): an installation from before
  `APP_SECRET` keeps its sessions and its encrypted tokens only if that value does not change.
- **`APP_SECRET` must be backed up apart from the database.** It cannot be recovered; a database restored
  without it loses every stored credential. The operator can decrypt every secret by design.
- Rotating `APP_SECRET` (a re-encryption command) is not part of this milestone; the stored key version is
  what a rotation will build on.
- The secret store (table `secrets`) that uses `secret-box.ts` comes with the admin portal issue.
