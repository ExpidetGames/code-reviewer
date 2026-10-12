// SPDX-License-Identifier: Apache-2.0

// The "how it works" text of a screen, behind a small disclosure: out of the way until it is asked
// for, and reachable with Tab. shadcn has no equivalent; this is a thin Apache-2.0 wrapper over the
// copied Collapsible, like the `InfoHint` over the Tooltip. The content stays in the DOM (forceMount)
// and is hidden with the native `hidden` attribute, so a screen reader skips it while it is closed.
"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function HelpDisclosure({
  label,
  children,
  className,
}: {
  /** The trigger text, a short question or noun phrase, for example "What makes a good password". */
  label: string;
  /** The explanation itself. */
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = `${useId()}-help`;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("text-sm", className)}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-controls={contentId}
          className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        hidden={!open}
        id={contentId}
        className="pt-1 text-muted-foreground"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
