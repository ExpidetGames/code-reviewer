// SPDX-License-Identifier: LicenseRef-Proprietary

// The root layout speaks for the product of the deployment (#740): the title and the identity the client components read follow
// PRODUCT_ID, at the point the server renders (a project of each product has its own variables).
//
// @vitest-environment node
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProductIdentity } from "@/product-identity/context";
import RootLayout, { generateMetadata } from "./layout.tsx";

// next/font only works inside the Next.js build; the class names are all the layout needs from it.
vi.mock("./fonts.ts", () => ({ fontVariables: "font-test" }));

afterEach(() => {
  vi.unstubAllEnvs();
});

function WhoAmI() {
  return <b>{useProductIdentity().name}</b>;
}

function page(children: ReactNode): string {
  return renderToStaticMarkup(
    <RootLayout params={Promise.resolve({})}>{children}</RootLayout>,
  );
}

describe("the root layout", () => {
  // #740-T03
  it("titles the pages with code-review.com while PRODUCT_ID is not set", () => {
    vi.stubEnv("PRODUCT_ID", "");

    const metadata = generateMetadata();

    expect(metadata.title).toEqual({
      default: "code-review.com",
      template: "%s · code-review.com",
    });
    expect(metadata.applicationName).toBe("code-review.com");
  });

  // #740-T03
  it("titles the pages with the factory when the deployment is the factory's", () => {
    vi.stubEnv("PRODUCT_ID", "factory");

    expect(generateMetadata().title).toEqual({
      default: "Factory",
      template: "%s · Factory",
    });
  });

  // #740-T03
  it("hands the identity of the deployment to the client components, for both products", () => {
    vi.stubEnv("PRODUCT_ID", "factory");
    expect(page(<WhoAmI />)).toContain("<b>Factory</b>");

    vi.stubEnv("PRODUCT_ID", "code-review-com");
    expect(page(<WhoAmI />)).toContain("<b>code-review.com</b>");
  });
});
