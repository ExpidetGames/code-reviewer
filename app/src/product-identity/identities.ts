// SPDX-License-Identifier: LicenseRef-Proprietary

// Who each product is (#740): one identity per product of `capabilities/products.ts`, keyed by its id, so there is no second
// selector next to `PRODUCT_ID`. Pure: no environment, no `server-only`, so a test, a client component's provider and
// Playwright can load it. The deployment's own value is `getProductIdentity()` in `current.ts`, which reads the environment.
import type { ProductId } from "../capabilities/products.ts";
import { CODE_REVIEW_COM } from "./code-review-com.ts";
import { FACTORY } from "./factory.ts";
import type { ProductIdentity } from "./identity.ts";

/** A product without an entry does not compile, so a new product cannot be added without its words. */
export const IDENTITIES: Readonly<Record<ProductId, ProductIdentity>> = {
  "code-review-com": CODE_REVIEW_COM,
  factory: FACTORY,
};

export function identityFor(product: ProductId): ProductIdentity {
  return IDENTITIES[product];
}
