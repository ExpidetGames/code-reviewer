// SPDX-License-Identifier: Apache-2.0

// A labelled loading placeholder for a `<Suspense>` fallback (rulebook R51). The bare shadcn
// `Skeleton` is a plain `div`; this wrapper gives it a name, so assistive technology announces what
// is being loaded, and marks it busy. `label` names the region ("Loading the setup").
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function PageLoading({
  label,
  className,
}: {
  /** The accessible name of the pending region, for example "Loading the setup". */
  label: string;
  /** Extra sizing, for example `size-8 rounded-full` for the user-menu placeholder. */
  className?: string;
}) {
  return (
    <Skeleton
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("h-40 w-full", className)}
    />
  );
}
