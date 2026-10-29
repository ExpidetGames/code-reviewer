// SPDX-License-Identifier: LicenseRef-Proprietary

// Which product this deployment is (#715, cut 7): the one place that picks the `ProductIdentity` the application is
// composed with. Every composition root (a route, a page, a `shared.ts`, the singletons of `auth/`) calls
// `getProductIdentity()` and hands the value down; no other file imports a product's value (`checkProductIdentityImports`).
// A deployment of another product, or a per-deployment choice, changes this file and nothing else.
import { CODE_REVIEW_COM } from "./code-review-com.ts";
import type { ProductIdentity } from "./identity.ts";

export function getProductIdentity(): ProductIdentity {
  return CODE_REVIEW_COM;
}
