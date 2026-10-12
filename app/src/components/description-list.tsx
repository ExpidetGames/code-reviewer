// SPDX-License-Identifier: Apache-2.0

// A dense term/description list (run facts, instance facts): a real `<dl>` so assistive technology
// pairs each term with its value. Ours (Apache-2.0); the tables of `components/ui/table.tsx` cover
// lists that need columns and a header instead.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DescriptionList({
  items,
  className,
}: {
  items: readonly { term: ReactNode; description: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid gap-2 text-sm", className)}>
      {items.map((item, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-4 gap-y-1"
        >
          <dt className="text-muted-foreground">{item.term}</dt>
          <dd className="min-w-0 text-foreground">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}
