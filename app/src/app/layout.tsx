// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/copy/product-name";
import { initialThemeScript } from "@/theme/theme";
import { ThemeSync } from "@/theme/theme-sync";
import { fontVariables } from "./fonts.ts";
// The one stylesheet of the app: the Tailwind v4 theme, the preflight reset and the base rules (#185).
import "./theme.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Automatic code reviews for GitHub pull requests.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the script below sets data-theme on <html> before React hydrates.
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* Applies a stored light/dark choice while the HTML is parsed, so the page never flashes
            the wrong mode. Without a stored choice the CSS follows the system setting. */}
        <script dangerouslySetInnerHTML={{ __html: initialThemeScript() }} />
      </head>
      <body>
        {/* Only for the Strict Mode remount of `next dev`, see theme-sync.tsx. */}
        {process.env.NODE_ENV !== "production" && <ThemeSync />}
        {children}
      </body>
    </html>
  );
}
