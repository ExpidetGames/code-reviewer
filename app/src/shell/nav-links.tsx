"use client";
// The three links of the main navigation. `NavLinks` takes the current path as a value so it can be
// rendered anywhere; `CurrentNavLinks` reads it from the router. The router read can wait for the
// request on routes with dynamic segments, so the shell wraps it in <Suspense> and shows
// `NavLinks` without a current page meanwhile.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isCurrentPage } from "./nav-items.ts";

export function NavLinks({
  pathname,
  onNavigate,
}: {
  pathname: string | null;
  /** Called when a link is chosen; the narrow menu closes itself with it. */
  onNavigate?: () => void;
}) {
  return (
    <ul className="nav-list">
      {NAV_ITEMS.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="nav-link"
            aria-current={
              isCurrentPage(pathname, item.href) ? "page" : undefined
            }
            onClick={onNavigate}
          >
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CurrentNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return <NavLinks pathname={usePathname()} onNavigate={onNavigate} />;
}
