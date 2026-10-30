# Bringing up the second App (factory): the owner's checklist

The pipeline lane for a second App exists but is dormant (`docs/deployment-vercel.md`, section 5.8). This is what you
do to switch it on. **Four steps are mandatory; everything after them is optional or deferred.** Nothing here changes
code-review.com until the `/dispatcher` entries of step 3: the Dispatcher then reads the registry and the operator
credential, which is why step 3 ends with a run that has the switch still off.

## Mandatory

1. **Create the database.** A Neon project in Frankfurt (or another region near the Vercel projects) with one database.
   Use the **direct** connection host, not the pooler (the App takes session advisory locks). Create the two roles with
   the SQL of `docs/deployment-vercel.md`, section 2 (migrate role and app role). Keep two URLs: the migrate role's and
   the app role's.
2. **Create the Vercel project.** In the existing team, root directory `app`, "Include source files outside of the Root
   Directory" on, Node.js 24.x, framework Next.js, Git auto-deploy off, *Protection Bypass for Automation* on. Note the
   project id and the bypass secret. The production alias `https://<project>.vercel.app` stays unprotected: it is the
   App's address (`BETTER_AUTH_URL`).
3. **Run the bootstrap, then fill Infisical.** `tools/factory-bootstrap/factory-bootstrap.sh` prints every entry and
   setting; `tools/factory-bootstrap/factory-bootstrap.sh --out <new file outside the repository>` also generates the
   five random secrets into that file (mode 0600, never printed). Put each value into its key (the script's table says
   folder and key), add the Secret Sync from `prod` `/app-factory` to the new Vercel project, then **delete the file**.
   Put the database URLs, the project id, the bypass secret and the App's address into their keys too. The App's own keys
   are not only the secrets: `PRODUCT_ID` (`factory`, **mandatory**; without it the project starts as code-review.com; the build copies it into
   `NEXT_PUBLIC_PRODUCT_ID` for the crash page, so that one is not set by hand, and a mismatch is logged at start),
   `PRODUCT_CAPABILITIES` (`review,dynamic-review`, billing off; `implementer` is allowed on this product but stays off until the rollout of the Implementer sets it, and then needs `dynamic-review`), `RUNNER_DISPATCH` (`webhook`), `RUNNER_WEBHOOK_URL` (the
   Dispatcher's `/dispatch` address), `RUNNER_WEBHOOK_KEY_ID` (`factory-k1`), `RUNNER_DISPATCH_MAX_RUNNING` (`2`) and, if the
   Dispatcher is protected, `RUNNER_WEBHOOK_BYPASS_TOKEN`. In `/dispatcher` put `DISPATCHER_APPS` (its `keyId` and
   `maxRunning` are the key id and the cap above) and the references to the App's token, its signing secret and the operator
   token. The script's table is the complete list, with the value or reference of each. Then run *Deploy production* once
   with the switch still off: its canary proves that the Dispatcher starts with the new registry.
4. **Set the repository variable `FACTORY_ENABLED` to `true`** (Settings, Secrets and variables, Actions, Variables) and
   run *Deploy production*. Do it only after the Dispatcher with the App registry and the App with the capability set
   are released. The first run stops at `apps-check` (`app_unreachable: factory`), because the second project has nothing
   live yet: promote its staged deployment by hand once (`docs/deployment-vercel.md`, section 5.8, "The first promotion
   needs one manual step"). Nothing of code-review.com depends on it.

## Optional or deferred

| Item | When you need it | Without it |
|---|---|---|
| The brand name of the second App | Before any user sees it. Everything it says (pages, mails, the check run and the GitHub App on GitHub) comes from one value, `app/src/product-identity/factory.ts`: the name is a one-line change there. Until then it is the codename "Factory", with no domain of its own (the address is `BETTER_AUTH_URL`). The browser icons are the shared mark | The App runs as "Factory" |
| GitHub App for the second App | The first real review. One click in its admin portal (Integrations) creates it from the manifest | Login, workspaces and settings work; GitHub is shown as not connected |
| A model key | The first review | Enter a workspace key in Settings, LLM access |
| Own domain and DNS | A brand launch | It runs on the `vercel.app` address; moving later means editing the GitHub App's three URLs and `BETTER_AUTH_URL` |
| Mail (SMTP sending domain) | Invitations, email verification, password reset | No mail: the first administrator comes from the setup wizard, sign-up stays closed |
| Stripe and legal URLs | Billing | The capability `billing` is off: no route, no page |
| Final product name and logo | Before anyone outside sees the App | The codename `factory` is shown |
| PostHog, landing page | Never for the second App | The App has no such code path |
| Making the lane a gate for the release | When the second App has users | A failure of the lane fails the run but never blocks code-review.com. It can delay the Dispatcher's promotion by the time limits of the lane's jobs (section 5.8) |

## After step 4

Run `pnpm --dir app setup-code` against the new database (with its migrate URL) and finish the setup wizard in the
browser: single tenant, sign-up closed. To go back: set `FACTORY_ENABLED` to anything but `true`; it is a repository
variable, not a variable of the environment `production`. To restore an earlier deployment of the second App: *Rollback
production* with `factory_deployment`.
