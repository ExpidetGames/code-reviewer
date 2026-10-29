// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The page for a crash in the root layout (#637). Next.js shows it in place of the root layout, so it
// brings what the layout would: its own <html> and <body>, the stylesheet with the theme tokens, the
// fonts and the light/dark choice. Inside it is the app's own error page (error.tsx), so both look and
// behave the same: no error details, "Try again", a way back to the start page. It fetches no data.
import { ERROR_COPY } from "@/components/system-page";
import { ProductIdentityProvider } from "@/product-identity/context";
import { builtProductIdentity } from "@/product-identity/public";
import { ThemeSync } from "@/theme/theme-sync";
import ErrorPage from "./error.tsx";
import { fontVariables } from "./fonts.ts";
// The one stylesheet of the app; the root layout that normally loads it is not there.
import "./theme.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    // suppressHydrationWarning: ThemeSync sets data-theme on <html> from the stored choice.
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* No metadata export in an error boundary; React hoists the title into <head>. */}
        <title>{ERROR_COPY.title}</title>
      </head>
      <body>
        {/* Puts a stored light/dark choice on <html>; without one the CSS follows the system. The
            inline script of the layout is no option here: this page is often rendered in the browser,
            where React never runs a <script> it renders. */}
        <ThemeSync />
        {/* Outside the root layout, so outside its provider: the product of this build. */}
        <ProductIdentityProvider product={builtProductIdentity()}>
          <ErrorPage error={error} retry={retry} />
        </ProductIdentityProvider>
      </body>
    </html>
  );
}
