// SPDX-License-Identifier: LicenseRef-Proprietary

// The color mode. By default the page follows the system setting (the CSS in theme.css reacts to
// `prefers-color-scheme`). A person can override it with the toggle; the choice is kept per browser
// in localStorage and applied as `data-theme="light|dark"` on <html>. No attribute means "follow the
// system". Everything here is plain functions so it can be tested without a browser; the hook
// (use-theme-choice.ts) and the inline script (initialThemeScript) are the two users.

export const THEME_STORAGE_KEY = "code-reviewer-theme";
export const THEME_ATTRIBUTE = "data-theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The part of `Storage` this module uses; the real localStorage and a test double both fit. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isStoredChoice(value: unknown): value is "light" | "dark" {
  return value === "light" || value === "dark";
}

/**
 * The stored choice. Nothing stored, an unknown value and storage that cannot be read (blocked,
 * private mode, no browser) all mean "follow the system"; this never throws.
 */
export function loadThemeChoice(storage: ThemeStorage | null): ThemeChoice {
  if (!storage) return "system";
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isStoredChoice(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Stores a choice; the system choice removes the entry. Never throws: the choice then only lasts for this page view. */
export function saveThemeChoice(
  storage: ThemeStorage | null,
  choice: ThemeChoice,
): void {
  if (!storage) return;
  try {
    if (choice === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage is blocked or full: the choice still applies to the open page.
  }
}

/** Puts a choice on the page: light or dark as an attribute, the system choice as no attribute. */
export function applyThemeChoice(root: Element, choice: ThemeChoice): void {
  if (choice === "system") root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, choice);
}

/** The browser's localStorage, or null where it cannot be reached (accessing it can throw). */
export function browserStorage(): ThemeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The inline script for <head>. It runs while the HTML is parsed, before the first paint, and
 * applies a stored choice so a reload never flashes the other mode. It repeats the rules of
 * `loadThemeChoice` and `applyThemeChoice` in plain ES5; theme.test.ts runs it against the same
 * cases. It takes `window` and `document` from its scope and never throws.
 */
export function initialThemeScript(): string {
  const key = JSON.stringify(THEME_STORAGE_KEY);
  const attribute = JSON.stringify(THEME_ATTRIBUTE);
  return (
    `try{var t=window.localStorage.getItem(${key});` +
    `if(t==="light"||t==="dark")document.documentElement.setAttribute(${attribute},t)}catch(e){}`
  );
}
