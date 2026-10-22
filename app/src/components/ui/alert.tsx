// SPDX-License-Identifier: MIT
// Adapted from shadcn/ui (MIT), https://ui.shadcn.com
// Local adaptation for Code Reviewer: the info/success/warning tone variants, `alertVariants` is
// exported for the static attention rows, `role` is a prop with the alert role as its default so a
// caller can opt out without depending on the spread order, and the chosen variant is mirrored in the
// `data-variant` attribute so a test can pin the tone. The look is the design board's (#633): a 12px
// radius on surface with a line-strong border; an error is outlined in fg on raised, a success outlined
// in fg, a warning on the todo pair. The text keeps the colour of the alert (no muted description).

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-xl border border-line-strong bg-surface p-4 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*5)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "text-foreground",
        destructive: "border-destructive bg-raised text-foreground",
        info: "bg-info-soft text-foreground",
        success: "border-success bg-surface text-foreground",
        warning: "border-warning bg-warning-soft text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  role = "alert",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "default"}
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-5 leading-5 font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-current [&_p]:leading-5",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
