// SPDX-License-Identifier: Apache-2.0

// What the user menu shows about the signed in person, and the avatars of members and installations (#638).
// The name is whatever GitHub gave us, so it is untrusted text: these functions only produce plain strings,
// React renders them as text.

export type ShellUser = {
  /** The display name from the GitHub profile; can be empty. */
  name: string;
  /** The GitHub login; always present. */
  login: string;
  /** The avatar address from the GitHub profile, if there is one. */
  avatarUrl?: string | null;
  /** Whether the person is the instance admin: the menu then links to the admin portal. */
  isInstanceAdmin?: boolean;
};

/** The name to show: the display name, or the login when the profile has none. */
export function displayName(user: ShellUser): string {
  const name = user.name.trim();
  return name === "" ? user.login : name;
}

// One capital letter per letter: some capitals are longer than the letter (ß becomes SS), which
// would overflow the avatar circle, so those stay as they are.
function capital(char: string): string {
  const upper = char.toUpperCase();
  return upper.length === char.length ? upper : char;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Up to two capital letters for the avatar circle, from the display name (or the login). */
export function initials(user: ShellUser): string {
  const letters = displayName(user)
    .split(/[\s\-_.]+/)
    .map((word) => Array.from(word).find((char) => LETTER_OR_DIGIT.test(char)))
    .filter((char): char is string => char !== undefined)
    .slice(0, 2)
    .map(capital);
  return letters.length === 0 ? "?" : letters.join("");
}

/** GitHub's avatar host: the one host an avatar is ever loaded from (#638). */
export const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";

/**
 * The avatar address if it is safe to load as an image: https on GitHub's avatar host (no port, no
 * credentials), otherwise null.
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.host === GITHUB_AVATAR_HOST &&
      parsed.username === "" &&
      parsed.password === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

const GITHUB_ACCOUNT_ID = /^[1-9][0-9]*$/;

/**
 * The avatar of a GitHub account (a user or an organization) from its numeric id, which the app stores
 * already; null for a missing id or one that is not a positive whole number.
 */
export function githubAvatarUrl(
  accountId: string | number | null | undefined,
): string | null {
  if (accountId === null || accountId === undefined) return null;
  const id = typeof accountId === "number" ? String(accountId) : accountId;
  if (!GITHUB_ACCOUNT_ID.test(id)) return null;
  return `https://${GITHUB_AVATAR_HOST}/u/${id}?v=4`;
}
