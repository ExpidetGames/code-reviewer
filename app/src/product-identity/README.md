# product-identity

Who the product is, as a value (#715, cut 7).

| File                 | Role                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `identity.ts`        | `ProductIdentity`: the name and what the mail settings show as the sender name. Imports nothing.                  |
| `code-review-com.ts` | The identity of code-review.com. Only `current.ts` imports it.                                                    |
| `current.ts`         | `getProductIdentity()`: the one place that picks the identity of the deployment. Every composition root calls it. |

A module that writes a word of the product (a mail, a title, a sentence of a page, the description at the payment provider)
takes a `ProductIdentity` as a parameter and never imports the product's value, so it can move to a package that another
product uses with its own identity. The composition roots (routes, pages, `shared.ts`, `auth/`) call `getProductIdentity()`; choosing the
identity per deployment changes `current.ts` and nothing else. `checkProductIdentityImports` (`src/ci/import-cycles/graph.ts`) holds the rule.

`code-review-com-output.test.tsx` holds everything the value ends up in (the five mails, the words of the model chooser and the
brand) against `code-review-com-output.golden.json`, recorded from the code before the cut.

A fact the product has no use for yet (a link to terms or privacy, a support address) is added to the type with its first
consumer.
