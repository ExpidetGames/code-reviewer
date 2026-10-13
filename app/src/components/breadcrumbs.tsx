// SPDX-License-Identifier: Apache-2.0

// The breadcrumb trail of a page below an area root (#179): a thin wrapper over the copied shadcn
// breadcrumb so every screen marks its location the same way. The trail starts at the area root,
// ancestors are links, and only the last crumb is the current page (`aria-current="page"`, no link).
// An earlier crumb without an `href` stays plain text. An area root itself carries no breadcrumb (the
// brand link already goes home). It goes into the `breadcrumb` slot of `PageHeader`.
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
                {current ? (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                ) : item.href === undefined ? (
                  <span className="text-foreground">{item.label}</span>
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
