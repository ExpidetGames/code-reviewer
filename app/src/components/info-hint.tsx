// SPDX-License-Identifier: LicenseRef-Proprietary

// A small "?" next to a label that explains it in a tooltip. It is reachable with Tab, announces its
// text through `aria-describedby` and closes on Escape. Wrapper over the copied shadcn
// Tooltip; a plain icon button must not be the only explanation, so the hint is announced, never
// colour or image alone.
"use client";

import { useId, useState, type ReactNode } from "react";
import { QuestionIcon } from "@phosphor-icons/react/dist/ssr";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function InfoHint({
  label,
  children,
}: {
  /** The accessible name of the "?" button, for example "About the model". */
  label: string;
  /** The hint itself, a sentence or two. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = `${useId()}-hint`;

  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen} delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-describedby={open ? descriptionId : undefined}
            className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            onClick={() => setOpen((current) => !current)}
          >
            <QuestionIcon aria-hidden="true" className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent id={descriptionId}>{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
