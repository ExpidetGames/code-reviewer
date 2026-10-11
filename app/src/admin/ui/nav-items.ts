// The five sections of the admin portal. One list feeds the links and the active state.

export const ADMIN_NAV_ITEMS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/setup", label: "Setup", exact: false },
  { href: "/admin/integrations", label: "Integrations", exact: false },
  { href: "/admin/mail", label: "Mail", exact: false },
  { href: "/admin/limits", label: "Limits", exact: false },
] as const;

/** Whether `pathname` is the section `item` (Overview only on its own path, the others also below it). */
export function isCurrentSection(
  pathname: string | null,
  item: (typeof ADMIN_NAV_ITEMS)[number],
): boolean {
  if (pathname === null) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
