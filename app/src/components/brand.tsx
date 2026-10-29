// SPDX-License-Identifier: LicenseRef-Proprietary

// The brand of the app as the design board draws it (#633): the logo mark (a check between two code
// brackets in a rounded tile, the tile in fg and the strokes in the page colour) next to the name in
// 16px semibold. The name comes from the product the page is for (`ProductIdentity`, #715 cut 7) and never breaks at its hyphen.
import { cn } from "@/lib/utils";
import type { ProductIdentity } from "@/product-identity/identity";

/** The logo tile alone; decorative, the name next to it carries the meaning. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn("size-6 shrink-0", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <g
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-background"
      >
        <path d="M10.5 10 6 16l4.5 6" />
        <path d="M21.5 10 26 16l-4.5 6" />
        <path d="m12.5 16.5 2.5 2.5 4.5-5.5" />
      </g>
    </svg>
  );
}

/**
 * The mark and the name, as one inline group. `compact` keeps the name for assistive technology only
 * on a narrow screen, so the floating nav fits a phone.
 */
export function Brand({
  product,
  className,
  compact = false,
}: {
  product: ProductIdentity;
  className?: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-base leading-6 font-semibold whitespace-nowrap text-foreground",
        className,
      )}
    >
      <BrandMark />
      <span className={compact ? "sr-only sm:not-sr-only" : undefined}>
        {product.name}
      </span>
    </span>
  );
}

/** The product name inside a sentence, kept on one line so it never breaks at its hyphen. */
export function ProductName({ product }: { product: ProductIdentity }) {
  return <span className="whitespace-nowrap">{product.name}</span>;
}
