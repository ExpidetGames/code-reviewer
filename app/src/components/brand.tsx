// SPDX-License-Identifier: Apache-2.0

// The brand of the app as the design board draws it (#633): the logo mark (a check between two code
// brackets in a rounded tile, the tile in fg and the strokes in the page colour) next to the name in
// 16px semibold. The name stays "Code Reviewer" until the rename has its own issue.
import { cn } from "@/lib/utils";

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

/** The mark and the name, as one inline group. */
export function Brand({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-base leading-6 font-semibold whitespace-nowrap text-foreground",
        className,
      )}
    >
      <BrandMark />
      Code Reviewer
    </span>
  );
}
