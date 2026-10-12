// SPDX-License-Identifier: Apache-2.0

"use client";
// The links of the main navigation: the places of the workspace the page is in (none outside a workspace).
// `NavLinks` takes the current path as a value so it can be rendered anywhere; `CurrentNavLinks` reads it from
// the router. The router read can wait for the request on routes with dynamic segments, so the shell wraps
// it in <Suspense> and shows `NavLinks` without a current page meanwhile.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { isCurrentPage, navItemsFor } from "./nav-items.ts";

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
      {navItemsFor(pathname).map((item) => (
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
  const pathname = usePathname();
  const shownPath = useRef(pathname);

  // The page changed, by whatever means (a link anywhere, back and forward): the narrow menu has
  // done its job. A click on a nav link closes it sooner through `onNavigate` on the link.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    onNavigate?.();
  }, [pathname, onNavigate]);

  return <NavLinks pathname={pathname} onNavigate={onNavigate} />;
}
