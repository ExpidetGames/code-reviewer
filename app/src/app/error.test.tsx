// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The app's own error page (#633) speaks for the product of the deployment (#740): it is a client component and reads the
// identity the root layout provides, never the server-side selector.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductIdentityProvider } from "@/product-identity/context";
import { identityFor } from "@/product-identity/identities";
import ErrorPage from "./error.tsx";

afterEach(cleanup);

function renderPage(product: ReturnType<typeof identityFor>) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return render(
    <ProductIdentityProvider product={product}>
      <ErrorPage error={new Error("boom")} retry={() => {}} />
    </ProductIdentityProvider>,
  );
}

describe("the error page", () => {
  // #740-T03
  it("carries the brand of the product it is rendered for", () => {
    renderPage(identityFor("factory"));

    expect(screen.getByText("Factory")).toBeTruthy();
    expect(document.body.textContent).not.toContain("code-review.com");
  });

  // #740-T03
  it("carries the brand of code-review.com for code-review.com", () => {
    renderPage(identityFor("code-review-com"));

    expect(screen.getByText("code-review.com")).toBeTruthy();
  });
});
