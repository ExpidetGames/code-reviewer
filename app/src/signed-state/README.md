# Signed state

The `state` value of a round trip through the browser and GitHub: the manifest flow that creates the GitHub
App (`src/github-config/`) and the authorization that links a GitHub identity to an account
(`src/github-signin/`). The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`, sections
2.4 and 2.9.

| File       | Role                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `state.ts` | `createSignedStates`: `issue` (a signed value and its row) and `consume` (verify and use up, once) |

- The value is `<purpose>.<nonce>.<expires at>.<user id>.<session hash>`, signed with HMAC-SHA256 under a key
  derived from `APP_SECRET` for the purpose `state-signing` (`src/crypto/sign.ts`, constant time
  comparison). It is integrity protected, not secret; it contains no credential.
- The nonce is also the id of a row in `signed_states`. `consume` accepts a state only when the signature
  matches, the purpose is the expected one, it has not expired, the person and the session that present it are
  the ones that started it, and the row exists and has not been used. The row is used up by one guarded
  statement (`update ... where used_at is null and expires_at > now`), so a state works once on every
  instance, whatever the timing of two requests.
- The refusal is a stable code (`state_invalid`) that does not say which of the checks failed, so a forged
  value learns nothing.
- Rows are removed by the clean-up of `src/maintenance/` once they have expired.
