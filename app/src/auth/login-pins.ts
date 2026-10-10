// A login is a name, not an identity: GitHub frees an old username after a rename, and somebody
// else can register it. So a login on `ALLOWED_GITHUB_LOGINS` is bound ("pinned") to the numeric
// GitHub id of the account that first used it, and only that account is admitted through the list
// (sign in: `sign-in-access.ts`, every request: `access-policy.ts`). Organization membership is not
// touched by this. The rows live in `allowed_login_pins` (`db/repositories/`).

/** What the comparison needs from the store: the repository's `pin`. */
export type LoginPins = {
  /**
   * Binds the login to the id unless it is bound already, and returns the id it is bound to now (the
   * given one if it was free, otherwise the earlier one). Null when that cannot be read.
   */
  pin(login: string, githubId: string): Promise<string | null>;
};

/**
 * - `match`: the login is bound to this account (first use binds it).
 * - `mismatch`: it is bound to another account.
 * - `unavailable`: the store could not say. Never treated as a match.
 */
export type PinCheck = "match" | "mismatch" | "unavailable";

export async function checkLoginPin(
  pins: LoginPins,
  login: string,
  githubId: string,
): Promise<PinCheck> {
  // An account without an id cannot be bound to anything.
  if (githubId === "") return "mismatch";
  try {
    const pinned = await pins.pin(login, githubId);
    if (pinned === null) return "unavailable";
    return pinned === githubId ? "match" : "mismatch";
  } catch {
    return "unavailable";
  }
}
