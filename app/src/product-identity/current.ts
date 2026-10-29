// SPDX-License-Identifier: LicenseRef-Proprietary

// Which product this deployment is (#715, cut 7; #740): the one place that reads the environment (`PRODUCT_ID`, through the
// capability set of the deployment) and picks the `ProductIdentity` the application is composed with. Every composition root
// (a route, a page, a `shared.ts`, the singletons of `auth/`) calls `getProductIdentity()` and hands the value down; a module
// that writes a word of the product takes the value as a parameter and never imports this file (`checkProductIdentityImports`).
// A client component gets the value from `ProductIdentityProvider` in the root layout (`context.tsx`).
import "server-only";
import { getDeploymentCapabilities } from "../capabilities/shared.ts";
import { identityFor } from "./identities.ts";
import type { ProductIdentity } from "./identity.ts";

export function getProductIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProductIdentity {
  return identityFor(getDeploymentCapabilities(env).product);
}
