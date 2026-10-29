# Capabilities (#731)

One codebase is deployed more than once (code-review.com, and a clone with another product). What a deployment
offers is its **capability set**: `review`, `dynamic-review`, `billing` (and later `implementer`). A feature outside
the set is **absent**, not switched off: no route, no navigation entry, no API endpoint, nothing enqueued or run in
the background.

## Settings

| Variable | Meaning |
|---|---|
| `PRODUCT_ID` | `code-review-com` (default) or `factory` |
| `PRODUCT_CAPABILITIES` | comma list; it can only narrow what the product `allowed`; unset = the product's `default` |

Unset, a deployment is exactly today's code-review.com: no new required variable. `dynamic-review` needs `review`.
`implementer` is known but allowed by no product (the code wall). A wrong setting stops the start
(`DEPLOY_CONFIG_INVALID`, `src/deploy/startup.ts`); it names the variable and never repeats an unknown value.

## Where the set is enforced

| Place | How |
|---|---|
| Proxy (`src/auth/access-proxy.ts`) | `routes.ts` maps every route to `core` or a capability; a path of an absent capability gets the answer of a path that does not exist (the `MISSING_PATH` rewrite), after the checks any path gets. Pages and APIs, the admin portal's `/admin/...` addresses included |
| Classification test (`routes.test.ts`) | fails for any `page.tsx`/`route.ts` under `src/app` that no pattern of `ROUTE_CLASSES` covers |
| Navigation | `shell/nav-items.ts`, `admin/ui/nav-items.ts`, `workspaces/ui/settings-sections.ts` carry a `capability`; client components read the set with `useCapabilities()` (`context.tsx`, provided by the root layout) |
| Jobs | the job repository refuses a review kind without its capability (`JOB_KIND_UNAVAILABLE`); the settings service refuses to save the Dynamic kind without `dynamic-review` |
| Background | the sweep (`dispatch/sweep.ts`) skips the steps of an absent capability; the billing helpers (`billing/shared.ts`) do nothing without `billing` |
| Billing | `billing/enabled.ts` (the one reader of the switch) answers "off" without `billing`, so no balance is read, no credit checked, no start credit granted, whatever a stored setting says |
| Health | `GET /api/health` reports `product` and `capabilities` |

A new page or route: add it to `ROUTE_CLASSES` or the classification test fails.
