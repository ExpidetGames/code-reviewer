// SPDX-License-Identifier: LicenseRef-Proprietary

// The sections of the admin portal, grouped the way the sidebar shows them. One list feeds the
// links and the active state. The Setup group holds the three sub-pages of the split (#181) and the
// Integrations group nests the GitHub App page under its index (#182/#185).

import type {
  Capability,
  CapabilitySet,
} from "../../capabilities/capability.ts";

export type AdminNavItem = {
  href: string;
  label: string;
  exact: boolean;
  /** Shown only in a deployment that has this capability (src/capabilities/). */
  capability?: Capability;
  /** Shows the number of open billing review rows next to the label (#603). */
  showsReviewCount?: boolean;
  /** Sub-pages of this section, rendered nested under its link (for example GitHub App under Integrations). */
  children?: AdminNavItem[];
};
export type AdminNavGroup = { label: string; items: AdminNavItem[] };

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: "Admin",
    items: [
      { href: "/admin", label: "Overview", exact: true },
      { href: "/admin/approvals", label: "Approvals", exact: false },
      // The newest runs of every workspace, with the call trace of each (#541).
      {
        href: "/admin/runs",
        label: "Runs",
        exact: false,
        capability: "review",
      },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/admin/setup/instance", label: "General", exact: false },
      { href: "/admin/setup/sign-up", label: "Sign-up", exact: false },
      { href: "/admin/setup/sign-in", label: "Sign-in", exact: false },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        href: "/admin/integrations",
        label: "Integrations",
        exact: true,
        // The index owns only its own path; the GitHub App page is its nested child (#182 lead note).
        children: [
          {
            href: "/admin/integrations/github",
            label: "GitHub App",
            exact: false,
          },
        ],
      },
      { href: "/admin/mail", label: "Mail", exact: false },
      // The operator's own LLM key (#276).
      { href: "/admin/llm", label: "LLM keys", exact: false },
      // The switch of billing, the payment adapter, the rates and the manual credit (#504). The index owns only its own path;
      // the payment reviews (#603) are its nested child, with the number of open rows on both.
      {
        href: "/admin/billing",
        label: "Billing",
        exact: true,
        capability: "billing",
        showsReviewCount: true,
        children: [
          {
            href: "/admin/billing/reviews",
            label: "Payment reviews",
            exact: false,
            showsReviewCount: true,
          },
        ],
      },
      // The models.dev catalog: what is new, what is enabled, what each costs us (#554).
      { href: "/admin/catalog", label: "Catalog", exact: false },
    ],
  },
];

/**
 * The groups a deployment shows: the sections of a capability it does not have are left out (a section takes its children with
 * it), and a group without sections with it.
 */
export function adminNavGroupsFor(
  capabilities: CapabilitySet,
): AdminNavGroup[] {
  return ADMIN_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        item.capability === undefined || capabilities.has(item.capability),
    ),
  })).filter((group) => group.items.length > 0);
}

/** Every section in one list, in the order the sidebar shows them (a parent before its children). */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV_GROUPS.flatMap(
  (group) => group.items.flatMap((item) => [item, ...(item.children ?? [])]),
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
