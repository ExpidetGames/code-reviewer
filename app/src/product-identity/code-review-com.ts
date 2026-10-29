// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of code-review.com (#635, #715 cut 7): "code-review.com", in lowercase everywhere, also at the start of a
// sentence (the design board, #633). The repository, the package names and the code identifiers keep "code-reviewer".
//
// Only the places where the application is composed import this module (`**/shared.ts`, `src/app/**`, the pages): the code
// that writes a word of the product receives the value (`identity.ts`). `product-identity.test.ts` holds that rule.
import type { ProductIdentity } from "./identity.ts";

const NAME = "code-review.com";

export const CODE_REVIEW_COM: ProductIdentity = {
  name: NAME,
  mailSenderNamePlaceholder: NAME,
};
