// What the user menu shows about the signed in person. The name is whatever GitHub gave us, so it
// is untrusted text: these functions only produce plain strings, React renders them as text.

export type ShellUser = {
  /** The display name from the GitHub profile; can be empty. */
  name: string;
  /** The GitHub login; always present. */
  login: string;
  /** The avatar address from the GitHub profile, if there is one. */
  avatarUrl?: string | null;
};

/** The name to show: the display name, or the login when the profile has none. */
export function displayName(user: ShellUser): string {
  const name = user.name.trim();
  return name === "" ? user.login : name;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Up to two capital letters for the avatar circle, from the display name (or the login). */
export function initials(user: ShellUser): string {
  const letters = displayName(user)
    .split(/[\s\-_.]+/)
    .map((word) => Array.from(word).find((char) => LETTER_OR_DIGIT.test(char)))
    .filter((char): char is string => char !== undefined)
    .slice(0, 2);
  return letters.length === 0 ? "?" : letters.join("").toUpperCase();
}

/** The avatar address if it is safe to load as an image (https only), otherwise null. */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
