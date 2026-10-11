// SPDX-License-Identifier: Apache-2.0

"use client";
// The navigation between the five sections of the portal. `SectionLinks` takes the path as a value;
// `AdminNav` reads it from the router, which can wait for the request, so the frame shows the links
// without a current section meanwhile.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { ADMIN_NAV_ITEMS, isCurrentSection } from "./nav-items.ts";

export function SectionLinks({ pathname }: { pathname: string | null }) {
  return (
    <ul className="nav-list admin-nav-list">
      {ADMIN_NAV_ITEMS.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="nav-link"
            aria-current={isCurrentSection(pathname, item) ? "page" : undefined}
          >
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CurrentSectionLinks() {
  return <SectionLinks pathname={usePathname()} />;
}

export function AdminNav() {
  return (
    <nav aria-label="Admin" className="admin-nav">
      <Suspense fallback={<SectionLinks pathname={null} />}>
        <CurrentSectionLinks />
      </Suspense>
    </nav>
  );
}
