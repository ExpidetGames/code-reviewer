// SPDX-License-Identifier: Apache-2.0

// The sections of the admin portal, grouped the way the sidebar shows them. One list feeds the
// links and the active state. The Setup group holds the three sub-pages of the split (#181); the
// Integrations → GitHub App sub-page arrives with #182.

export type AdminNavItem = { href: string; label: string; exact: boolean };
export type AdminNavGroup = { label: string; items: AdminNavItem[] };

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: "Admin",
    items: [
      { href: "/admin", label: "Overview", exact: true },
      { href: "/admin/approvals", label: "Approvals", exact: false },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/admin/setup/instance", label: "Instance", exact: false },
      { href: "/admin/setup/sign-up", label: "Sign-up", exact: false },
      { href: "/admin/setup/sign-in", label: "Sign-in", exact: false },
    ],
  },
  {
    label: "Integrations",
    items: [
      { href: "/admin/integrations", label: "Integrations", exact: false },
      { href: "/admin/mail", label: "Mail", exact: false },
    ],
  },
];

/** Every section in one list, in the order the sidebar shows them. */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV_GROUPS.flatMap(
  (group) => group.items,
);

/** Whether `pathname` is the section `item` (Overview only on its own path, the others also below it). */
export function isCurrentSection(
  pathname: string | null,
  item: AdminNavItem,
): boolean {
  if (pathname === null) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
