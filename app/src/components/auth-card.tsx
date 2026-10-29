// SPDX-License-Identifier: LicenseRef-Proprietary

// The frame of the public auth pages (#170): a full-height centered column with one card at 34rem
// and the action-named h1. The card, its surface and the type scale come from the component kit;
// this wrapper only holds the layout the four pages share (login, sign-up, forgot-password,
// reset-password). The look is the design board's bare card (#633): a 28rem surface card with 32px
// padding on the page ground under the brand, and a 30px title in the text gradient of the page titles.
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/brand";
import { TITLE_GRADIENT_CLASS } from "@/components/page-header";
import type { ProductIdentity } from "@/product-identity/identity";

export function AuthCard({
  product,
  title,
  children,
  className,
}: {
  /** The product whose brand the page shows. */
  product: ProductIdentity;
  /**
   * The one h1 of the page: the action it serves, for example "Sign in". Left out when the page
   * brings its own heading in `children` (the first-run setup, whose wizard owns the h1 per step).
   */
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-16 text-foreground">
      <Brand product={product} />
      <Card className={cn("w-full max-w-md gap-6 py-8", className)}>
        <CardContent className="flex flex-col gap-6 px-8">
          {title === undefined ? null : (
            <h1 className={cn("pb-1 text-3xl leading-9", TITLE_GRADIENT_CLASS)}>
              {title}
            </h1>
          )}
          {children}
        </CardContent>
      </Card>
    </main>
  );
}
