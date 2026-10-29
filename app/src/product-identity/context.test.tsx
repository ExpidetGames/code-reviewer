// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The identity of the deployment for client components (#740): the root layout hands it down, a component asks for it.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductIdentityProvider, useProductIdentity } from "./context.tsx";
import { identityFor } from "./identities.ts";

afterEach(cleanup);

function Name() {
  return <p>{useProductIdentity().name}</p>;
}

describe("the identity for client components", () => {
  // #740-T03
  it("is the one the provider carries", () => {
    render(
      <ProductIdentityProvider product={identityFor("factory")}>
        <Name />
      </ProductIdentityProvider>,
    );

    expect(screen.getByText("Factory")).toBeTruthy();
  });

  // #740-T03
  it("is code-review.com for a component rendered alone, like the capability set", () => {
    render(<Name />);

    expect(screen.getByText("code-review.com")).toBeTruthy();
  });
});
