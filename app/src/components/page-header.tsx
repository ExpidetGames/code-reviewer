// SPDX-License-Identifier: LicenseRef-Proprietary

// The heading block at the top of a page: the one `h1` of the page, an optional breadcrumb, an
// optional one-line description the title cannot carry, and the page's primary actions on the right.
// proprietary (our own composition); the primitives it uses live under `components/ui/`.
//
// The look is the design board's page header (#633): a 36px title with the one text gradient of the
// design (hero-from to hero-to, clipped to the text), an 18px muted lead, the actions aligned to the
// bottom of the title block.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The text gradient of the board's page titles, for the one h1 of a page (never a background). */
export const TITLE_GRADIENT_CLASS =
  "bg-linear-to-r from-hero-from to-hero-to bg-clip-text text-transparent";

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
    <header className="flex flex-col gap-3">
      {breadcrumb ? <div>{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className={cn(
                "pb-1 text-3xl leading-9 break-words sm:text-4xl sm:leading-10",
                TITLE_GRADIENT_CLASS,
              )}
            >
              {title}
            </h1>
            {badge}
          </div>
          {description ? (
            <p className="max-w-hero text-lg leading-7 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
