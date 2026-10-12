// SPDX-License-Identifier: Apache-2.0

// The breadcrumb trail of a non-root page (#179): a thin wrapper over the copied shadcn breadcrumb
// so every screen marks its location the same way. Ancestors are links, the last crumb is the current
// page (`aria-current="page"`, no link). It goes into the `breadcrumb` slot of `PageHeader`.
import Link from "next/link";
import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type BreadcrumbCrumb = {
  /** The visible text of the crumb. */
  label: string;
  /** Where the crumb leads; the last crumb is the current page and needs none. */
  href?: string;
};

export function Breadcrumbs({
  items,
  className,
}: {
  /** The trail from the area root to the current page, last item last. */
  items: readonly BreadcrumbCrumb[];
  className?: string;
}) {
  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <Fragment key={`${String(index)}:${item.label}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem>
                {current || item.href === undefined ? (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={item.href}>{item.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
