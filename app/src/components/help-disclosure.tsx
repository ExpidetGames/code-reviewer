// SPDX-License-Identifier: Apache-2.0

// The "how it works" text of a screen, behind a small disclosure: out of the way until it is asked
// for, and reachable with Tab. shadcn has no equivalent; this is a thin Apache-2.0 wrapper over the
// copied Collapsible, like the `InfoHint` over the Tooltip. The content stays in the DOM (forceMount)
// and is hidden with the native `hidden` attribute, so a screen reader skips it while it is closed.
// The look is the design board's disclosure (#633): a bordered box on the page ground, the question as
// a 14px semibold row with the chevron at its end, the answer in muted text below it.
"use client";

import { useId, useState, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function HelpDisclosure({
  label,
  ariaLabel,
  children,
  className,
}: {
  /** The trigger text, a short question or noun phrase, for example "What makes a good password". */
  label: string;
  /**
   * The accessible name when the same visible label repeats on one screen (one disclosure per row):
   * a distinct name per control, for example "Evidence for acme". Left out, the visible label is the
   * name.
   */
  ariaLabel?: string;
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
      className={cn(
        "rounded-xl border border-border bg-background text-sm",
        className,
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-controls={contentId}
          className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-4 py-3 text-left font-semibold text-foreground transition-all hover:bg-surface"
        >
          {label}
          <CaretDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        hidden={!open}
        id={contentId}
        className="flex flex-col gap-2 px-4 pb-4 text-muted-foreground"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
