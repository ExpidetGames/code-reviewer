# The component kit (epic #165)

This folder is the app side of the shadcn/ui kit. It is Apache-2.0. The copied primitives live next
to it, under `ui/`, and keep their MIT header (see `THIRD_PARTY_LICENSES.md` and
`app/src/ci/spdx-headers/rules.ts`).

## What a screen imports

- **Primitives**: `@/components/ui/<name>` (`button`, `card`, `badge`, `alert`, `field`, `empty`,
  `table`, `dialog`, `sheet`, `dropdown-menu`, `select`, `tabs`, ...). These are the copied shadcn
  components; each file is adapted only where a short comment says so.
- **App wrappers** (ours, in this folder): use these instead of hand-writing the pattern.
  - `@/components/button` — the Button for screens: variants `primary | secondary | ghost |
destructive`, sizes `sm | default | icon`, the `loading`/`loadingLabel` convention and the
    icon-only accessible-name guard. Prefer it over `@/components/ui/button`.
  - `@/components/page-header` — one `h1`, a breadcrumb slot and the page actions.
  - `@/components/info-hint` — the focusable "?" next to a label (Tooltip, `aria-describedby`,
    Escape closes, 44px hit area).
  - `@/components/help-disclosure` — the "how it works" trigger over the Collapsible: the text stays
    in the DOM and is hidden while closed, the trigger announces `aria-expanded`/`aria-controls` and
    has a 44px target.
  - `@/components/status-region` — `role="status"`, `aria-live="polite"`.
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
- Sidebar links (the shadcn `SidebarMenuButton`, whose `default` size is 32px / `h-8`) get a 44px row
  on a coarse pointer — a touch screen — through Tailwind's `pointer-coarse:h-11`, and stay 32px on a
  fine pointer — a mouse. The two numbers of the rule are read as "at least 44px for a touch target,
  at least 32px for a pointer target": a mouse does not need the taller row, and keeping 32px there
  preserves the density the mockups show. `SIDEBAR_LINK_CLASS` (`src/shell/nav-items.ts`) carries that
  height together with the colour and underline rules, so both sidebars use it.

## Cascade layers

Tailwind is imported by `app/src/app/theme.css`, which declares the layer order
`@layer theme, base, components, utilities;`. `app/src/app/globals.css` (the legacy stylesheet of the
migration) declares the same order and keeps its **element-level** rules — `*`, `html`, `body`,
`a`, `button`, headings — in `@layer base`, so a Tailwind utility on a kit component wins over them.
Its legacy **class** rules (`.btn`, `.card`, ...) stay unlayered on purpose: they must keep winning
until their screens move. `app/src/app/globals-layers.test.ts` fails on a new unlayered element rule.

## During the migration

- No screen has moved yet. The screens still render the legacy wrappers in `app/src/ui/*` (`.btn`,
  `.page-header`, `.empty-state` and friends) and keep their current look.
- Each screen issue (#168+, #170+...) migrates its call sites to the kit above and deletes a legacy
  wrapper once its last usage is gone; the cleanup (#185) removes `globals.css` and the rest.
- Do not add new uses of `app/src/ui/*`; treat that folder as frozen until it is deleted.
