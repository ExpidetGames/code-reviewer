// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { CapabilitiesProvider } from "@/capabilities/context";
import { getCapabilities } from "@/capabilities/shared";
import { ProductIdentityProvider } from "@/product-identity/context";
import { getProductIdentity } from "@/product-identity/current";
import { initialThemeScript } from "@/theme/theme";
import { ThemeSync } from "@/theme/theme-sync";
import { fontVariables } from "./fonts.ts";
// The one stylesheet of the app: the Tailwind v4 theme, the preflight reset and the base rules (#185).
import "./theme.css";

// The title follows the product of the deployment (`PRODUCT_ID`, read when the server renders or builds: a project of the
// other product has its own build and its own variables), so it is a function and not a constant of the module.
export function generateMetadata(): Metadata {
  const { name } = getProductIdentity();
  return {
    applicationName: name,
    title: { default: name, template: `%s · ${name}` },
    description: "Automatic code reviews for GitHub pull requests.",
  };
}

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
        {/* What this deployment offers (src/capabilities/), for the navigation and the other client components. */}
        <CapabilitiesProvider capabilities={getCapabilities().list()}>
          {/* Who this deployment is (src/product-identity/), for the client components that write a word of the product. */}
          <ProductIdentityProvider product={getProductIdentity()}>
            {children}
          </ProductIdentityProvider>
        </CapabilitiesProvider>
      </body>
    </html>
  );
}
