// SPDX-License-Identifier: Apache-2.0

// The heading block at the top of a page: the one `h1` of the page, an optional breadcrumb, an
// optional one-line description the title cannot carry, and the page's primary actions on the right.
// Apache-2.0 (our own composition); the primitives it uses live under `components/ui/`.
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  breadcrumb,
  badge,
  actions,
}: {
  title: string;
  /** One line the title cannot say; longer explanations belong in an InfoHint. */
  description?: string;
  /** A `<Breadcrumb>` (from `@/components/ui/breadcrumb`) or any navigation that marks the location. */
  breadcrumb?: ReactNode;
  /** A short status of the page's subject, shown next to the title (for example the viewer's role). */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-6">
      {breadcrumb ? <div>{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            {badge}
          </div>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
