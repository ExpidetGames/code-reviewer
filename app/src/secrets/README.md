# Secret store

The encrypted credentials of the instance (the SMTP password, the GitHub App's private key, webhook secret
and client secret, and the operator's own LLM key, `operator_llm_key`, #276). How it works, what it never does and how it fails is in
[`src/admin/README.md`](../admin/README.md), "The secret store"; the decision is in
`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.7.

| File              | Role                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `names.ts`        | The closed list of secret names (the row id that is bound into the ciphertext)                           |
| `store.ts`        | `createSecretStore`: `save`, `status`, `statuses`, `use`, `remove`, on top of `src/crypto/secret-box.ts` |
| `secret-value.ts` | `SecretValue`: a value that prints as `[secret]`; `reveal()` is the only way to the text                 |
| `shared.ts`       | `getSecretStore()` on the running server's database                                                      |

The rows are read and written by `src/db/repositories/secrets-repository.ts`.

Workspace secrets (a workspace's own LLM key, `llm_api_key`) belong to a workspace and live in the table
`workspace_secrets`, through `workspace-store.ts` (`createWorkspaceSecretStore`, one store per workspace; the names
are `WORKSPACE_SECRET_NAMES`). Same encryption, but the additional authenticated data is the table, the **workspace
id** and the name, and every secret carries a `binding` (what it was made for, the provider of an LLM key) that
the caller compares before using it. The LLM key built on it is described in `src/llm/README.md`.
