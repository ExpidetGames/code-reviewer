// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of this build for code that runs outside the root layout and its provider (#740): the page for a crash in the
// root layout renders in the browser, where the environment of the server is not. `next.config.ts` inlines `PRODUCT_ID` as
// `NEXT_PUBLIC_PRODUCT_ID` at build time (a project of each product has its own build and variables); an empty or unknown value
// is the default product, the same as on the server, which refuses to start with an unknown one.
import {
  DEFAULT_PRODUCT_ID,
  PRODUCT_IDS,
  type ProductId,
} from "../capabilities/products.ts";
import { identityFor } from "./identities.ts";
import type { ProductIdentity } from "./identity.ts";

export function builtProductIdentity(
  value: string | undefined = process.env.NEXT_PUBLIC_PRODUCT_ID,
): ProductIdentity {
  const id = value?.trim() ?? "";
  const known = (PRODUCT_IDS as readonly string[]).includes(id);
  return identityFor(known ? (id as ProductId) : DEFAULT_PRODUCT_ID);
}
