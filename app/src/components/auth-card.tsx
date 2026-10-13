// SPDX-License-Identifier: Apache-2.0

// The frame of the public auth pages (#170): a full-height centered column with one card at 34rem
// and the action-named h1. The card, its surface and the type scale come from the component kit;
// this wrapper only holds the layout the four pages share (login, sign-up, forgot-password,
// reset-password).
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function AuthCard({
  title,
  children,
  className,
}: {
  /**
   * The one h1 of the page: the action it serves, for example "Sign in". Left out when the page
   * brings its own heading in `children` (the first-run setup, whose wizard owns the h1 per step).
   */
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4 text-foreground">
      <Card className={cn("w-full max-w-[34rem] gap-4 py-6", className)}>
        <CardContent className="flex flex-col gap-4">
          {title === undefined ? null : (
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          )}
          {children}
        </CardContent>
      </Card>
    </main>
  );
}
