// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The identity of the deployment for client components (#740). The root layout reads it on the server (`getProductIdentity()`)
// and hands it down; a client component asks `useProductIdentity()` and never calls the selector, which reads the environment
// on the server. Without a provider (a component rendered alone in a test) the answer is code-review.com, like the
// capability set (`capabilities/context.tsx`); the layout test pins that the provider is there.
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_PRODUCT_ID } from "../capabilities/products.ts";
import { identityFor } from "./identities.ts";
import type { ProductIdentity } from "./identity.ts";

const ProductIdentityContext = createContext<ProductIdentity>(
  identityFor(DEFAULT_PRODUCT_ID),
);

export function ProductIdentityProvider({
  product,
  children,
}: {
  product: ProductIdentity;
  children: ReactNode;
}) {
  return (
    <ProductIdentityContext.Provider value={product}>
      {children}
    </ProductIdentityContext.Provider>
  );
}

export function useProductIdentity(): ProductIdentity {
  return useContext(ProductIdentityContext);
}
