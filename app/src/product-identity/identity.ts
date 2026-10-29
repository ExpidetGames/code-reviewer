// SPDX-License-Identifier: LicenseRef-Proprietary

// Who the product is, as a value (#715, cut 7). A module that writes a word of the product (a mail, a title, a description at
// the payment provider) gets this from the application that composes it and never imports the name: the name differs per
// product, and the code that writes the words must not know which product it runs in. This module imports nothing, so it can
// move to a shared package as it is; the value of code-review.com is `code-review-com.ts`, next to it.
//
// Only what a consumer reads today is here. A fact the product has no use for yet (a link to terms, a support address) is
// added as a field with its first consumer, the application's value gets it then.

export type ProductIdentity = {
  /**
   * The name of the product as every page, text and mail writes it. A text of the product that has the name in it takes it
   * from here; a sentence breaks at its hyphen unless a page keeps the name on one line (`ProductName` in `components/brand.tsx`).
   */
  readonly name: string;
  /** What the sender-name field of the mail settings shows while it is empty: the name the mail goes out under by default. */
  readonly mailSenderNamePlaceholder: string;
};
