// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { initialThemeScript } from "@/theme/theme";
import { ThemeSync } from "@/theme/theme-sync";
// The legacy kit and the Tailwind v4 theme live next to each other during the migration (#165);
// `theme.css` holds every color token and brings in Tailwind (see the file's header).
import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  title: { default: "Code Reviewer", template: "%s · Code Reviewer" },
  description: "Automatic code reviews for GitHub pull requests.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the script below sets data-theme on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
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
