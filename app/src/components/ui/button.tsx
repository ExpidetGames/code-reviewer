// SPDX-License-Identifier: MIT
// Adapted from shadcn/ui (MIT), https://ui.shadcn.com
// Local adaptation for Code Reviewer: the native-control reset (appearance-none bg-transparent),
// `no-underline` so a link rendered as a button (`asChild`) does not take the base link underline
// (#185 review), and the look of the design board (#633): 8px radius, semibold 16px (14px small),
// primary in fg, secondary on surface with a line-strong border, destructive outlined in fg, a 2px
// lift on hover and the base focus outline (2px fg, 2px offset) instead of a ring.

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer appearance-none items-center justify-center gap-2 rounded-lg border border-transparent bg-transparent font-semibold whitespace-nowrap no-underline transition-all select-none hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-2 aria-invalid:border-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive:
          "border-foreground bg-background text-foreground hover:bg-raised",
        outline:
          "border-line-strong bg-secondary text-secondary-foreground hover:bg-raised-strong",
        secondary:
          "border-line-strong bg-secondary text-secondary-foreground hover:bg-raised-strong",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-foreground underline decoration-line-strong underline-offset-4 hover:translate-y-0 hover:decoration-foreground",
      },
      size: {
        default: "min-h-10 px-3 py-2 text-base",
        xs: "min-h-7 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-9 gap-1.5 px-3 py-1.5 text-sm",
        lg: "min-h-11 px-4 py-2 text-base",
        icon: "size-10",
        "icon-xs": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
