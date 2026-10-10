# Color mode

Light and dark. The page follows the system setting by default; the toggle in the user menu
(System, Light, Dark) overrides it, and the choice is kept per browser in `localStorage`
(`code-reviewer-theme`, only `light` or `dark`; "System" removes the entry).

| File               | Role                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.ts`         | The rules as plain functions: `resolveColorMode`, `loadThemeChoice` (an unknown stored value or unreadable storage means System, never an error), `saveThemeChoice`, `applyThemeChoice`, `initialThemeScript`.                                 |
| `theme-toggle.tsx` | The three buttons. The page is the source of truth: the pressed button follows `data-theme` on `<html>` (observed), so it also matches a choice made by the script. A choice made in another tab applies to that tab only until the next load. |
| `theme-sync.tsx`   | Re-applies the stored choice after React reset `<html>` (development Strict Mode remount) and follows changes from other tabs.                                                                                                                 |

How it works: `initialThemeScript()` is an inline script in `<head>` (root layout). It sets
`data-theme="light|dark"` on `<html>` while the HTML is parsed, so there is no flash of the other
mode. The tokens in `src/app/globals.css` use `light-dark()` with `color-scheme`: without the
attribute `color-scheme: light dark` lets the system decide, with it the choice is pinned. Without
JavaScript the page simply follows the system.

The browser baseline (`light-dark()` needs Chrome 123, Firefox 120, Safari 17.5) is in the root
`README.md`.

Nothing is stored on the server and no cookie is used: the layout stays static (Cache Components).
