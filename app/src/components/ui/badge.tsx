// SPDX-License-Identifier: MIT
// Adapted from shadcn/ui (MIT), https://ui.shadcn.com
// Local adaptation for Code Reviewer: the neutral/success/warning/danger/info status variants, and
// `no-underline` so a badge rendered as a link does not take the base link underline (#185 review).
// The look is the design board's (#633): a pill with a line-strong outline, 12px semibold. The board has
// no status colours, so the tones differ by fill and outline: success is outlined in fg, danger is
// filled in fg, neutral sits on raised, warning on the todo pair, info on surface. A status is never
// told by the fill alone: the label (and, where the caller adds one, an icon) is always in the badge.

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-line-strong px-3 py-1 text-xs leading-4 font-semibold whitespace-nowrap text-foreground no-underline transition-all aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "[a&]:hover:bg-surface",
        secondary:
          "border-transparent bg-raised text-muted-foreground [a&]:hover:bg-raised-strong",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground",
        outline: "[a&]:hover:bg-surface",
        ghost: "border-transparent [a&]:hover:bg-surface",
        link: "border-transparent underline underline-offset-4",
        neutral: "border-transparent bg-raised text-muted-foreground",
        success: "border-success bg-success-soft text-success",
        warning: "border-warning bg-warning-soft text-warning",
        danger: "border-danger bg-danger text-background",
        info: "bg-info-soft text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
