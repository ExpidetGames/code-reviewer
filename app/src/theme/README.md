# Color mode

Light and dark. The page follows the system setting by default; the toggle in the user menu
(System, Light, Dark) overrides it, and the choice is kept per browser in `localStorage`
(`code-reviewer-theme`, only `light` or `dark`; "System" removes the entry).

| File                  | Role                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.ts`            | The rules as plain functions: `resolveColorMode`, `loadThemeChoice` (an unknown stored value or unreadable storage means System, never an error), `saveThemeChoice`, `applyThemeChoice`, `initialThemeScript`.                                                                                                                                                                  |
| `use-theme-choice.ts` | `useThemeChoice()` reads the current choice and writes a new one; the user menu renders it as the three radio entries (System, Light, Dark) and the labels. The page is the source of truth: the choice follows `data-theme` on `<html>` (observed), so it also matches a choice made by the script. A choice made in another tab applies to that tab only until the next load. |
| `theme-sync.tsx`      | Re-applies the stored choice after React reset `<html>` (development Strict Mode remount) and follows changes from other tabs.                                                                                                                                                                                                                                                  |

How it works: `initialThemeScript()` is an inline script in `<head>` (root layout). It sets
`data-theme="light|dark"` on `<html>` while the HTML is parsed, so there is no flash of the other
mode. The color tokens live in `src/app/theme.css` as plain custom properties per mode: a light
block on `:root`, a `@media (prefers-color-scheme: dark)` block for the system state (no
attribute), and a `:root[data-theme="dark"]` block for the pinned choice; that file also carries the
`color-scheme` rules that follow the same choice. Without JavaScript the page simply follows the
system.

The browser baseline (Chrome and Edge 111, Firefox 128, Safari 16.4 — Tailwind CSS v4) is in the
root `README.md`.

Nothing is stored on the server and no cookie is used: the layout stays static (Cache Components).
