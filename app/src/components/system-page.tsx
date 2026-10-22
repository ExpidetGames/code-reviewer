// SPDX-License-Identifier: Apache-2.0

// The frame of the two system states of the design board (#633): the page that is not found and the
// page that failed. The floating nav pill with the brand alone (the page knows nothing of the session),
// then the state in the centre: a large mark, the one h1, a muted sentence and the ways on.
import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { cn } from "@/lib/utils";

/** The words of the page that is not found (the design board, K1). */
export const NOT_FOUND_COPY = {
  title: "Page not found",
  description: "The page does not exist, or you do not have access to it.",
  back: "Back to the start page",
} as const;

/** The words of the page that failed (the design board, K2). */
export const ERROR_COPY = {
  title: "Something went wrong",
  description:
    "Reload the page and try again. If it keeps happening, tell the admin of this instance.",
  retry: "Try again",
  back: "Back to the start page",
} as const;

export function SystemPage({
  mark,
  title,
  description,
  children,
}: {
  /** The large mark above the title: the "404" or a symbol. Decorative. */
  mark: ReactNode;
  title: string;
  description: string;
  /** The actions: a way back, a retry. */
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex justify-center px-4 pt-6">
        <div className="flex items-center rounded-full border border-border bg-background/70 p-2 shadow-nav backdrop-blur-xl">
          <Link
            href="/"
            className="flex min-h-11 items-center rounded-full py-1 pr-3 pl-2 no-underline"
          >
            <Brand />
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-page flex-col items-center gap-4 px-4 pt-32 pb-24 text-center md:px-8">
        <div aria-hidden="true">{mark}</div>
        <h1 className="text-3xl leading-9 sm:text-4xl sm:leading-10">
          {title}
        </h1>
        <p className="max-w-[30rem] text-muted-foreground">{description}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {children}
        </div>
      </main>
    </div>
  );
}

/** The 96px "404" of the board, in the text gradient of the page titles. */
export function BigNumber({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "bg-linear-to-r from-hero-from to-hero-to bg-clip-text pb-2 text-8xl leading-none font-semibold tracking-tight text-transparent",
        className,
      )}
    >
      {children}
    </p>
  );
}
