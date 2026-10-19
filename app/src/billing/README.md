# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and a self-hoster who never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

What is here today is only the part every later billing issue builds on. Server-only: every source file imports
`"server-only"` (`server-only.test.ts`).

| File            | What it is                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`   | The instance setting `billing_settings`: `{ enabled }` today, the rates later. `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, and `enabled` is true only when it is exactly `true`. |
| `enabled.ts`    | `isBillingOn(db)`: the one reader of the switch. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                        |
| `public-url.ts` | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                              |

## The switch

`isBillingOn` reads the instance setting `billing_settings.enabled` and nothing else. It calls nobody and reads no
billing table. The readiness of the payment adapter joins the answer with the adapter (#501, #504). **There is exactly
one reader of the switch**; a test (`src/ci/billing-cleanup.test.ts`) fails when a second one appears. Every billing
route, page and sweep step asks `isBillingOn` first: while it is false they are inert, a route answers the 404 of a path
that does not exist (`guardBillingRoute`, Next.js's own `notFound()`), no billing table is read and nobody is called.

There is no environment variable: billing is configured in the admin portal and in nothing else, so `.env.example` and
the deployment files stay as they are for a self-hoster (`no-environment-variable.test.ts`).

The credentials of a payment provider are encrypted, write-only secrets of the secret store (`src/secrets/`, ADR 0006
2.14); no name of one is in `SECRET_NAMES` yet. A row of a removed secret name that an old database still holds is not
read, not listed and not an error.

## Where billing is not allowed to reach

- A browser: `server-only.test.ts` fails when a client component imports this folder, directly or through a file.
- The environment: see above.
- A workspace's data: anything a later issue stores about a workspace is scoped to it (`src/db/README.md`, "Workspace
  scoping").
