# The component kit (epic #165)

This folder is the app side of the shadcn/ui kit. It is Apache-2.0. The copied primitives live next
to it, under `ui/`, and keep their MIT header (see `THIRD_PARTY_LICENSES.md` and
`app/src/ci/spdx-headers/rules.ts`).

## What a screen imports

- **Primitives**: `@/components/ui/<name>` (`button`, `card`, `badge`, `alert`, `field`, `empty`,
  `table`, `dialog`, `sheet`, `dropdown-menu`, `select`, `tabs`, ...). These are the copied shadcn
  components; each file is adapted only where a short comment says so. The `badge` carries the
  `neutral | info | success | warning | danger` tones; a status is never told by colour alone (the
  label is always in the badge). `danger` is the soft tone for a failed state, next to the solid
  `destructive` used for errors.
- **App wrappers** (ours, in this folder): use these instead of hand-writing the pattern.
  - `@/components/button` — the Button for screens: variants `primary | secondary | ghost |
destructive`, sizes `sm | default | icon`, the `loading`/`loadingLabel` convention and the
    icon-only accessible-name guard. Prefer it over `@/components/ui/button`.
  - `@/components/page-header` — one `h1`, a breadcrumb slot, a badge slot next to the title (a short
    status of the page's subject, never colour alone) and the page actions.
  - `@/components/breadcrumbs` — the trail of a page below an area root (#179 lead decision): the trail
    starts at the area root, ancestors are links, and only the last crumb is the current page
    (`aria-current="page"`, no link). An **area root** (Projects list, Account, Invitations, Admin
    overview, workspace Settings index) shows **no** breadcrumb, and there is no global "Home" crumb:
    the brand link in the shell already goes home. Goes into the `breadcrumb` slot of `PageHeader`.
  - `@/components/auth-card` — the centered 34rem frame and action-named `h1` of the public auth pages.
  - `@/components/info-hint` — the focusable "?" next to a label (Tooltip, `aria-describedby`,
    Escape closes, 44px hit area).
  - `@/components/help-disclosure` — the "how it works" trigger over the Collapsible: the text stays
    in the DOM and is hidden while closed, the trigger announces `aria-expanded`/`aria-controls` and
    has a 44px target. An optional `ariaLabel` gives a repeated disclosure a distinct accessible name
    (one per row, for example "Evidence for acme") while the visible label stays short.
  - `@/components/status-region` — `role="status"`, `aria-live="polite"`, and an optional `label` so the
    live regions of one page (an update result, a copy result) are told apart.
  - `@/components/needs-attention` — the one attention region of a screen: a labelled "Needs attention"
    section with up to `maxRows` (default 2) `Alert` rows and the rest behind a `HelpDisclosure`.
    Screens with notices (#173, #174, #178) use it instead of stacking separate notice regions.
  - `@/components/danger-zone` — a destructive `Card` with the confirmation in an `AlertDialog`.
  - `@/components/description-list` — a dense `<dl>` for run/instance facts.
  - `@/components/query-tabs` — the `Tabs` whose active tab lives in the query string. It calls
    `useSearchParams`, so a page that renders it needs a `<Suspense>` boundary.

## Hit areas

The epic's rulebook asks for ≥44×44px touch targets (R66). The shell reads it per control:

- Icon-only controls keep at least 44×44px: `@/components/button` with `size="icon"` and the shadcn
  `SidebarTrigger` (the shell gives it `size-11`).
- The two header triggers that carry the avatar and a name (the user menu and the workspace switcher)
  are at least 44px tall (`min-h-11 min-w-11`).
- Sidebar links (the shadcn `SidebarMenuButton`, whose `default` size is 36px / `h-9`) get a 44px row
  on a coarse pointer — a touch screen — through Tailwind's `pointer-coarse:h-11`, and stay 36px on a
  fine pointer — a mouse. The two numbers of the rule are read as "at least 44px for a touch target,
  at least 32px for a pointer target": a mouse does not need the taller row, and keeping 36px there
  preserves the density the mockups show. `SIDEBAR_LINK_CLASS` (`src/shell/nav-items.ts`) carries that
  height together with the colour and underline rules, so both sidebars use it.

## Cascade layers

Tailwind is imported by `app/src/app/theme.css`, which declares the layer order
`@layer theme, base, components, utilities;` and imports Tailwind's `theme`, `preflight` (the reset,
`@layer base`) and `utilities` stylesheets. The project's element-level rules (`body`, headings, `a`,
`:focus-visible`) live in `@layer base` too, so a Tailwind utility on a kit component wins over
them. The `a` rule underlines a link in running text, and the kit Button/Badge plus the standalone
nav, menu, breadcrumb and table/card links opt out with `no-underline`. `src/theme/theme.test.ts`
asserts that the `@layer base` block carries `body` and `:focus-visible` and no legacy class rule,
and that the `a` rule underlines.

## The migration is finished

The legacy hand-written kit is gone (#185): `app/src/app/globals.css` (tokens and classes) and the
`app/src/ui/*` wrappers (`button`, `page-header`, `empty-state`) are deleted. Every screen already
renders the kit above; there is no frozen folder left to avoid. Colours live only in
`app/src/app/theme.css` (the colour guard in `src/ci/colors` scans every other source file with no
exception), and `app/src/ci/legacy-classes/legacy-classes.test.ts` fails if a removed class name is
used again.
