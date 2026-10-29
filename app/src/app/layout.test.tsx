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
  it("keeps the whole head metadata of code-review.com as it was before the identity (no new tag)", () => {
    vi.stubEnv("PRODUCT_ID", "");

    // toStrictEqual on the whole object: a key added for the identity (application-name, openGraph, ...) is a new tag in the
    // <head> of every page of code-review.com and fails here.
    expect(generateMetadata()).toStrictEqual({
      title: {
        default: "code-review.com",
        template: "%s · code-review.com",
      },
      description: "Automatic code reviews for GitHub pull requests.",
    });
  });

  // #740-T03
  it("gives the factory the same metadata keys with its own name", () => {
    vi.stubEnv("PRODUCT_ID", "factory");

    expect(generateMetadata()).toStrictEqual({
      title: { default: "Factory", template: "%s · Factory" },
      description: "Automatic code reviews for GitHub pull requests.",
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
