// SPDX-License-Identifier: MIT
// Adapted from shadcn/ui (MIT), https://ui.shadcn.com
// Local adaptation for Code Reviewer: the 20px box of the design board (#633), filled in fg when
// checked, with the base focus outline.

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-5 shrink-0 rounded-md border border-input bg-background transition-all disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-2 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
