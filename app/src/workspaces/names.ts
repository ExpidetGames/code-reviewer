// SPDX-License-Identifier: Apache-2.0

// The names a workspace has: the display name a person types, and the slug in its address (`/w/<slug>`).
// Pure functions. A name is shown in pages and put into mails (the subject and the text of an
// invitation), so it never holds a control character, a line break or an invisible formatting character:
// none of those can end a mail header or hide where a name ends. The slug is made from the name, in the
// letters and digits of the address alphabet only, and is never trusted as a permission: whoever types a
// slug into the address bar is still checked for membership (src/workspaces/access.ts).

export const WORKSPACE_NAME_MAX_LENGTH = 80;
export const WORKSPACE_SLUG_MAX_LENGTH = 48;

/** What the slug of a workspace looks like: lower case letters and digits, single hyphens between. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Control characters (C0, C1, DEL, which includes CR, LF and tab), the formatting characters (zero width
// joiners, bidirectional overrides, the byte order mark) and the two Unicode line separators.
const FORBIDDEN_IN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export type WorkspaceNameResult =
  { ok: true; name: string } | { ok: false; error: "invalid_name" };

/** A name of 1 to 80 characters after trimming, without control or formatting characters. */
export function validateWorkspaceName(raw: unknown): WorkspaceNameResult {
  if (typeof raw !== "string") return { ok: false, error: "invalid_name" };
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > WORKSPACE_NAME_MAX_LENGTH)
    return { ok: false, error: "invalid_name" };
  if (FORBIDDEN_IN_TEXT.test(name)) return { ok: false, error: "invalid_name" };
  return { ok: true, name };
}

/**
 * Text that comes from somebody else (a workspace name, a person's display name) made safe to put on one
 * line of a mail: control and formatting characters become a space, runs of white space become one space,
 * and the result is cut to `maxLength` characters. Used for every such value in a mail header (the subject)
 * and in the text, so a name with a line break cannot start a new header or a new paragraph.
 */
export function oneLine(text: string, maxLength = 80): string {
  const flattened = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...flattened];
  return characters.length <= maxLength
    ? flattened
    : `${characters.slice(0, maxLength - 1).join("")}…`;
}

/** The slug a name leads to, before it is made unique: `Team A` is `team-a`. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    // The accents that NFKD split off.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKSPACE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? "workspace" : slug;
}

/**
 * A slug nobody has: the base itself, then `base-2`, `base-3` and so on (the base is shortened so the
 * suffix fits). `exists` is asked inside the transaction that inserts the workspace, and the unique
 * constraint of the column is what holds if two people ask at once anyway.
 */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(base))) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${base.slice(0, WORKSPACE_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("No free slug was found.");
}
