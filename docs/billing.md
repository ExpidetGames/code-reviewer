# Billing: guide for the operator of a hosted instance

Billing lets an instance charge for reviews. It is **prepaid pay-as-you-go**: a workspace tops up a balance in US
dollars and every review takes its price from that balance. There are no plans and no subscriptions. Payments go through
Stripe Managed Payments, Stripe is the merchant of record, and the app keeps a journal of every movement of money.

This guide is for the person who runs the hosted instance and owns the Stripe account. It tells you what billing does,
what to set up in Stripe, how to set the rates, in which order to go live, and how to run it afterwards.

- If you run your own instance and do not want to sell anything, read [Billing for self-hosters](billing-self-hosting.md).
  Billing is off by default and a self-hoster who never switches it on sees no change.
- The points your terms must carry are in [Billing: checklist for the terms](billing-terms-checklist.md).
- The design and its reasons are in the decision record
  [0006](decisions/0006-prepaid-billing-via-stripe-managed-payments.md). The code is described in
  `app/src/billing/README.md`.
- The hosted deployment itself (the webhook route must be reachable) is in [Deploy on Vercel](deployment-vercel.md),
  section 3.6. The Compose deployment is in [Deploy with Coolify](deployment-coolify.md).

**Every number in this guide is made up.** They are examples to show the arithmetic. The real rates are your decision.
They are never in the repository, and they are not in this guide.

## 1. What billing does

### The balance

Each workspace has one balance in US dollars. It is the sum of an append-only journal, so nothing is ever edited or
deleted. A mistake is fixed by a new entry. The workspace page **Settings, Billing** shows the balance, the journal and the
price of each review to everyone in the workspace. Owners and Admins can also add credit, save the billing details and
set a monthly spending limit.

### What a review costs

```
AI price             = real AI cost x factor A      (only when the review runs on your models)
Infrastructure price = started minutes x rate B     (one rate for Diff, one for Dynamic)
Price of the review  = AI price + infrastructure price
```

- **Factor A** and the two **rates B** are set by you in the admin portal. They have no default. Billing cannot be switched
  on before all three are set.
- A minute that has started is charged whole. There is no minimum price: a review that costs nothing charges nothing.
- A workspace chooses its key mode. On **your models** it pays AI plus infrastructure. On **its own provider key** it
  pays infrastructure only.
- The workspace sees the two final prices of each review, the AI part and the infrastructure part. It never sees A, B,
  the minutes or your real cost. This is decided and stays so.

Example (made up): the real AI cost is 0.10 dollars, A is 2.0, and the review used 4 started minutes at a rate of 0.020
dollars. The AI price is 0.20, the infrastructure price is 0.08, and the review costs 0.28 dollars.

### Who pays when something goes wrong

| What happened to the review                                                                              | AI price                        | Infrastructure price |
| -------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------- |
| Result delivered                                                                                         | yes (your models, cost known)   | yes                  |
| Failed or stopped at a limit, but the model ran                                                          | yes                             | yes                  |
| Ended without a result, or cancelled or replaced by a newer commit                                       | yes                             | yes                  |
| AI cost unknown (for example the provider did not report it)                                             | no                              | yes                  |
| Clearly our fault: VM failed to start, crash, a timeout, our infrastructure, the managed key failing     | no                              | no                   |
| A replaced review that failed with our error                                                             | no                              | no                   |
| Never ran (refused at the start, or cancelled while it waited)                                           | no                              | no                   |

The rule is: **free only when the failure is clearly ours, everything else is charged.** On the workspace's own key the AI
price is always zero, and a failure of that key is the workspace's. The exact list of codes is in
`app/src/billing/outcome.ts` and its README.

### Starting a review, and the balance

- A review **starts whenever the balance is above zero**, even by one cent. Nothing is held or blocked when it starts.
- The price is taken when the review **ends**. It may take the balance **below zero**. This is accepted.
- At **zero or below** the workspace cannot start a review. The pull request gets one notice, "Add credit to continue",
  and the workspace has to add credit and push again (or comment `/review`).
- Because nothing is held, many reviews can start at once on a small balance, and together they can take it far below
  zero. The hourly brake below limits how many start.

### Start credit

A workspace with a connected GitHub installation gets the start credit the first time it meets billing, once per GitHub account. The default is 2 dollars
and you can change it or set it to 0 (no start credit). It is tied to the GitHub account, not to the workspace, so
deleting and re-creating a workspace does not give a second one. It is the only free tier.

### Top-ups, refunds and the negative balance

- A top-up is between 10 and 500 dollars, in US dollars. At the first top-up the workspace confirms that it buys for a business. It may give
  a VAT ID. The credit is the amount **without** VAT. Credit never expires. There is no auto-recharge.
- **We do not refund credit.** Stripe can still refund a payment within 60 days, and a buyer can dispute a charge.
  When that happens the app takes the matching share of the credit back. If the credit was already spent, the balance
  goes **below zero** and the workspace is blocked until a top-up lifts it above zero.
- You refund by hand in the Stripe dashboard. There is no refund button in the app. The webhook books the refund.

### Limits

- The workspace's own **monthly spending limit** (optional, set by an Owner or Admin): a new review is refused once this
  UTC month's charges have reached it. A review that runs is never stopped.
- The **hourly brake** (you set the number, default 60): the most reviews a workspace can start in a rolling hour. It is
  hidden. The workspace is told only that reviews are paused for a while.
- While billing is on, the per-period run quotas of the entitlements are not applied. The operator API limits stay.

## 2. Before you start

Check these before you plan the go-live. Each is explained below.

- The hosted instance runs a release that contains the payment reviews page (`/admin/billing/reviews`, #603) and the rule
  that a review which ended while billing was off is never charged (#591). Both are merged; do not go live on an older
  release.
- The public address of the app (`BETTER_AUTH_URL`) is an https address that Stripe can reach, and nothing in front of
  `POST /api/billing/webhook` challenges or rewrites the request ([Deploy on Vercel](deployment-vercel.md), section 3.6).
- The Dispatcher is of a release that reports its VMs (`vm_lifecycle`). The app refuses to switch billing on while a
  Dispatcher without it has claimed within a day. Without it hosted reviews would measure zero minutes and be free.
- The instance has a **mail server** set up in the admin portal. Without it the low and empty balance mails are not sent
  (the banner and the pull request notice still work).
- You have a Stripe account that is, or can be, enrolled in Managed Payments (section 3), and your terms are ready and
  published at an address (section 5; [the checklist](billing-terms-checklist.md)).
- You decided the rates (section 4). Do not copy the examples of this guide.

## 3. The Stripe account

You do these steps in the Stripe dashboard. Nothing in the repository holds a Stripe secret, and none of these steps asks
you to paste one into a chat or an issue.

1. **Use a test account first.** Everything in this guide works in test mode. Do the whole of sections 3 to 5 with test
   keys before you touch live mode.
2. **Managed Payments.** Enroll the account in Managed Payments and pass Stripe's eligibility review for your business
   entity. The review is Stripe's and can take time. The app asks for Managed Payments on every top-up checkout, so Stripe
   will not create it for an account that is not enrolled. The connection check does not prove this; the first test top-up does.
3. **The product tax code.** The top-up is sold as one line, "Review credit", with the tax code `txcd_10105002`. Stripe
   must accept that code for your product under Managed Payments. If it refuses, the checkout is refused too.
4. **The API key.** Create a **restricted** key with the least permissions that work. The app uses these Stripe resources:
   customers (with their tax IDs), Checkout sessions, payment intents (read), invoices (read, for the invoice list of the
   workspace page), webhook endpoints, and the account (the connection check reads it). It does not create refunds. Test the key with the connection check (section 5) and one
   test top-up, and widen it only as far as a failure shows.
5. **Test and live keys are separate.** A key starting `sk_test_` or `rk_test_` is the test environment, a key starting
   `sk_live_` or `rk_live_` is live. The admin page shows the environment it read from the prefix. The app sends events
   only to the environment of its key: a test event at a live instance, or the reverse, is refused.
6. **The webhook endpoint.** Do not create it by hand. The admin page does it (section 5): it registers
   `https://<your public address>/api/billing/webhook` at Stripe with the events the app reads and stores the signing
   secret. Do this once for test and once for live. An endpoint of the other environment than the key's is refused.
7. **If the Stripe account is shared with another product**, the endpoint also receives that product's events. They are
   recorded for review and fill the review list. Prefer a Stripe account of its own for the instance.
8. **Put a rate limit on the webhook route** at your platform (the Vercel firewall or the proxy in front of the server).
   A few dozen requests a minute per address is plenty, because Stripe's own deliveries are few.

Invoices and receipts are issued and emailed by Link, the merchant of record. The app makes no promise about
VAT-compliant invoices until you have verified them in the sandbox (the maintainer task #503). The workspace page says
only that receipts come from Link.

**Invoices on the workspace page (#659).** Owners and Admins see the card **Invoices** on Settings, Billing: the invoices
Stripe lists for the workspace's own Stripe customer (`GET /v1/invoices?customer=...`), newest first, with date, number,
amount, status and a link to read each one and to download its PDF (Stripe's hosted page and PDF; the app keeps no copy).
Nothing else is listed: the customer is the one the app stored for the workspace's billing profile, never a filter from
the request. A Member does not see the card and the route refuses them. The app does **not** ask Checkout for invoice
creation (`invoice_creation`): Managed Payments does not support it, the merchant of record issues the invoice itself,
and the fake Stripe refuses the parameter like the documentation says. The charge, the prices and the wording of the
page are unchanged. Whether a Managed Payments payment really leaves an Invoice object at Stripe is part of #503: until
you have seen it in the sandbox, the card may be empty on a real instance, and then says "No invoices yet". The
restricted API key needs read access to invoices for this card (section 3, step 4).

## 4. The rates and numbers

In the admin portal, menu **Billing**, the card **Rates and numbers**:

| Field                                  | What it is                                                                                           | Example (made up) |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------- |
| Factor A                               | Multiplies the real AI cost on your models. At least 1.                                              | 2.0               |
| Rate per started minute, Diff          | Dollars per started minute of a Diff review.                                                         | 0.020             |
| Rate per started minute, Dynamic       | Dollars per started minute of a Dynamic review.                                                      | 0.030             |
| AI reserve per Diff review             | Not used any more, but still required. Any value in range works.                                     | 0.10              |
| Start credit                           | Granted once per GitHub account. 0 switches it off. Default 2.                                        | 2                 |
| Low-balance threshold                  | A balance below this sends the "low" mail once. Default 5.                                           | 5                 |
| Hourly review limit per workspace      | The hidden brake. Default 60.                                                                        | 60                |

- Pick A and B from your real costs (the Vercel Sandbox minutes, the functions and the model price list) and your fees.
  Stripe's fee comes out of your payout, not out of the buyer's credit.
- The page takes decimals. Under the page the app stores whole numbers (A in ten-thousandths, money in micro-dollars),
  so no rounding error enters an amount.
- You can change every number at any time, also while billing is on. A change applies to reviews that end afterwards.
- The AI reserve is a leftover. It stays required until the follow-up #608 removes it.

## 5. Switching billing on

On the **Billing** page:

1. **Payment adapter.** Choose `stripe`. (`manual` is for instances without a payment provider, see the self-hoster
   guide.) The adapter cannot be changed while billing is on.
2. **Stripe credentials.** Paste the API key and click save. The key is write-only: the page shows only whether it is
   stored and its last four characters. Click **Check connection**. It reads the Stripe account and records a pass. A new
   key clears the pass and has to pass again.
3. **Webhook endpoint.** Click the button that creates the endpoint. The app asks Stripe first and adopts an endpoint of
   its own address that already exists, so a second click does not make a duplicate. If Stripe already has an endpoint of
   ours but the secret is not stored, the page asks you to enter the secret (Stripe shows it only when the endpoint is
   created) or to recreate the endpoint while billing is off.
4. **Rates and numbers.** Section 4.
5. **Terms and privacy links.** Enter the link to your terms (and, optionally, to your privacy statement) in the card
   **Terms and privacy**. Each is an `https` address of a public website with no user name or password (at most 2,048
   characters). The business confirmation at a workspace's first top-up links to them. With Stripe the terms link is
   required: switching billing on without it is refused with `terms_url_missing`, and while billing is on with Stripe the
   terms link cannot be removed (it can be changed). With the manual adapter both are optional.
6. **The switch.** Read the statement the page shows, then switch billing on. The app judges everything again in one
   step. If something is missing it refuses and names each item (`factor_a_missing`, `minute_rate_diff_missing`,
   `minute_rate_dynamic_missing`, `diff_ai_reserve_missing`, `stripe_api_key_missing`, `stripe_webhook_secret_missing`,
   `connection_check_missing`, `terms_url_missing`, `connection_check_failed`, `dispatcher_lacks_vm_lifecycle`).

When billing is on:

- Every workspace is charged. A workspace with no balance gets the start credit on its first contact, or cannot start
  a review until you or a top-up add credit.
- Every workspace is on **your models** by default, whatever its entitlements said. A workspace can switch to its own
  key on Settings, LLM access.
- The settings navigation shows **Billing** instead of **Plan**.
- The run quotas of the entitlements are not applied.

If the switch is on but the setup is no longer ready (a credential vanished from a damaged database, or a Stripe setup
switched on before the terms link existed: the update of #626 made the link required and fills in nothing for you), every
page of the admin portal shows the banner **Billing is switched on but not complete** with the missing items, and the
Billing page says "the switch is on, but billing is not running". Every review is then refused with
`billing_rates_incomplete`: its pull request gets one notice per pushed commit ("the billing setup of this instance is not
complete", naming no item) and its check run **Code Reviewer** is completed as neutral with that reason. Complete the item
the banner names (for the terms link: enter it in **Terms and privacy**; it can be added while billing is on), or switch
billing off (reviews then run without charge). **Before you deploy an update that adds a required item, add it first.**

### Changing the Stripe key

- A new key of the same environment must pass the connection check before it replaces the working one.
- A key of the **other environment** is refused while billing is on (it would take the webhook secret with it). Switch
  billing off first, change the key, create the endpoint again, check, and switch on.
- You cannot remove a credential while billing is on.

## 6. The go-live order

The code is built on fakes. Before it charges a real buyer, a person with the accounts must do the following in this
order. The tracking issue is #510. Record a result and a date on each item there; never write a secret anywhere.

1. **Stripe account (test).** Section 3 in test mode: Managed Payments, the tax code, a restricted test key, the webhook
   endpoint with the signing secret.
2. **Prove the webhook before real buyers can pay.** Once a workspace can save its billing details it can pay, and a
   payment made while the webhook does not credit is taken by Stripe and credited to nobody. So switch billing on first
   on staging with test keys, and see one sandbox payment credited end to end. Only then switch billing on in production.
3. **Blockers that must be in the release you deploy:**
   - #591: a review that ended while billing was off is not charged, and no hold is left behind (merged, and simplified
     by #605 which removed holds).
   - #603: the payment reviews page, so a buyer who paid and was not credited is visible and repairable (merged).
   - #604, N1: verify in the sandbox which currency refunds and disputes carry for a buyer who paid in a local currency
     (Adaptive Pricing is always on under Managed Payments). Until then such a refund opens a review row instead of
     debiting. Fail-closed, but check it before live money.
   - #503: verify invoices and the VAT ID on Managed Payments in the sandbox (the maintainer task). The result decides
     what your product copy may say about invoices.
4. **Set the rates** in the admin portal (section 4). The rates come from the cost research (#492). Confirm the start
   credit.
5. **Legal and tax.** The terms follow [the checklist](billing-terms-checklist.md) and are read by a lawyer. The privacy
   text names the billing profile and Stripe. A tax advisor has confirmed VAT on prepaid credit. The terms are published
   at an address you enter on the billing page (section 5, step 5); the business confirmation links to it.
6. **The live purchase test.** One small real top-up with a business email, one review charged, one refund through the
   Stripe dashboard, and the negative balance seen once. Check the Link receipt and the activity page.
7. **Safety nets.** The journal check (`verify()`) runs daily while billing is on and shows its result on the billing page;
   set an alert on the log code `BILLING_JOURNAL_INCONSISTENT` (section 8). Watch the unknown-cost line and the review rows. Switch billing off and on again on staging once.
8. **Staged enablement.** Staging first, then production with one internal workspace, then everyone. Have a rollback plan
   (section 9). Look at the database read-only before and after.
9. **Tell the workspaces first.** What changes for existing workspaces (a balance of zero plus the start credit, and the
   key mode choice) is written down before the switch is turned on.

## 7. Running billing day to day

### Credits and corrections by hand

On the **Billing** page, the card for credit: search a workspace by name, see its balance and its ten newest entries, and
write either a **credit** (a top-up entry) or a signed **correction**. A note is required, up to 500 characters. An
amount is at most 10,000 dollars at once. The request has an id, so a repeated click is one entry. Use this for a goodwill
credit, to repair a payment that could not be credited, or to fix a mistake. It works whether billing is on or off.

### Payment reviews

The menu entry **Payment reviews** (`/admin/billing/reviews`) lists payments the app could not credit by itself. A badge
shows how many are open. The app never guesses here; a person decides.

| Outcome             | What it means                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `intent_unresolved` | An event about a payment that is none of our top-ups (for example another product on a shared Stripe account). |
| `amount_rejected`   | A payment or a refund with an amount, currency or environment that does not fit what we asked for.      |
| `amount_conflict`   | A payment that changes the amount of a credit that was already given.                                   |
| `event_invalid`     | A signed event the app could not read.                                                                  |

For each row you see the workspace, our top-up and the Stripe object. Look the payment up in the Stripe dashboard (the row
holds no amount of the buyer). Then:

- **Check payment** asks Stripe about the top-up and applies the answer exactly as the webhook would. Use it first.
- **Credit** writes a manual credit or correction for the workspace the row names, and closes the row in one step. The
  row decides the type: a credit for a payment, a correction for a refund or dispute.
- **Close** with a note, when no money should move.

A closed row keeps who closed it, when and why. A row is never closed without a note.

### A buyer paid and sees no credit

The workspace page has **Check payment** on every pending top-up. If it does not help, look in **Payment reviews** and in
the log (section 8). A top-up that Stripe expired or that failed shows its state on the workspace page.

### Refunds and disputes

- To refund, use the Stripe dashboard (within the 60 days Stripe allows). The webhook books it as a refund entry. The app
  takes back the matching share of the credit, rounded down: a full refund of a payment takes back the whole credit,
  a partial refund takes the same share.
- A **dispute** is debited when it opens, because Stripe takes the money then. If you win it, the app reverses the debit
  once. A lost dispute keeps it.
- If the buyer already spent the credit, the balance goes below zero. The workspace is blocked ("The balance is below
  zero") until it tops up above zero or you correct the balance.
- A refund or dispute that is larger than its payment, or that together with the others takes back more than the credit,
  is `amount_rejected` and final. Repair it with a manual correction, not by asking Stripe to deliver again.

### Negative or empty balance

Both stop new reviews and post one notice on the pull request. The Owners and Admins get one mail (when it falls below the
low threshold, and when it reaches empty) and see a banner. A top-up, a start credit or a manual credit lifts the block as
soon as the balance is above zero. Credit never expires.

### The monthly limit and the hourly brake

A workspace sets its own monthly limit. You cannot set it for them. If a workspace asks why reviews stopped, the refusal is
in the Runs page and the log: `monthly_limit_reached` or `reviews_paused`. The hourly brake is yours: raise the number on the
Billing page when a legitimate burst trips it. Never tell a workspace the number.

## 8. Monitoring, logs and refusal codes

### Where the codes show

- **Runs page (admin, `/admin/runs`)**: the stored error code of every refused review.
- **Server log**: a refusal writes `[queue] job=<id> workspace=<id> refused at claim: <code>`.
- **Workspace**: the pull request notice, the banner and the page.

### Refusal codes at the start of a review

| Code                        | Meaning and what to do                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `insufficient_balance`      | The balance is exactly zero. The workspace adds credit.                                                     |
| `balance_negative`          | The balance is below zero (a review ended, or a refund or dispute took it there). Top-up or correction.     |
| `monthly_limit_reached`     | The workspace's own limit was reached. An Owner or Admin changes it.                                        |
| `reviews_paused`            | The hidden hourly brake. Raise the number if the burst is legitimate.                                       |
| `billing_rates_incomplete`  | Billing is on but the setup is not ready (a rate, a credential, the check or the terms link is missing). Complete the item the admin banner names. A notice per commit. |
| `billing_limits_unreadable` | The brake or limit could not be evaluated. Look at `CLAIM_CAPS_FAILED`. No notice.                          |

### Log lines to watch

| Line                                                                           | Meaning                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `billing_webhook_rejected code=<code>`                                         | A webhook was refused (bad, old or missing signature). Many of these mean a wrong signing secret or a proxy that rewrites the body. |
| `billing_webhook_needs_review outcome=<code>`                                  | A payment needs a person. See Payment reviews.                       |
| `billing_webhook_event_invalid`                                                | A signed event was not an event. Recorded when it has an id.         |
| `billing_webhook_failed code=<code>`, `billing_webhook_adapter_failed`         | The webhook failed and answered 500. Stripe will deliver again.      |
| `billing_webhook_credit_pending`                                               | A refund or dispute arrived before its credit. Answered 503, Stripe delivers again. |
| `billing_webhook_applied outcome=<code>`                                       | A normal delivery.                                                   |
| `[billing] TOPUP_STARTED workspace=<id> result=<code>`                         | A top-up was started. Never an amount.                               |
| `[billing] TOPUP_CHECKED workspace=<id> result=<code>`                         | "Check payment" was used.                                            |
| `billing_review_resolved provider=<p> event=<id> actor=<user> entry=<id\|none>`| A review row was closed.                                             |
| `[billing] BILLING_PRICING_FAILED job=<id> code=<code>`                        | A run could not be priced. It was charged nothing. Look at it.       |
| `[usage] job=<id> workspace=<id> settled with an unknown cost ...`             | A run had no known AI cost. It is charged its minutes only. Many of these mean a provider that does not report cost. |
| `[billing] CLAIM_CAPS_FAILED workspace=<id> error=<kind> retry=<yes\|no>`       | The limits could not be read. Retried or refused.                    |
| `[billing] BILLING_START_CREDIT_GRANTED` / `BILLING_START_CREDIT_FAILED`       | The start credit.                                                    |
| `[billing] BALANCE_MAIL_FAILED workspace=<id> kind=<kind> code=<code>`         | A mail did not go out (`not_configured` means no mail server).       |
| `[billing] MONTHLY_LIMIT_CHANGED workspace=<id> user=<id> ...`                 | A workspace changed its monthly limit.                               |
| `[billing] WALL_CLOCK_NOT_RECORDED`, `DISPATCHER_NOT_NOTED`                    | A measure of a job without a VM, or a note of a Dispatcher, failed. |
| `[billing] BILLING_JOURNAL_INCONSISTENT workspace=<id> ...`, `BILLING_JOURNAL_CHECK_DONE ...` | The daily journal check found a workspace whose balance and journal differ, or finished a pass. |

The logs name codes and ids only. They never hold a body, a header, a secret, an amount of a payment or a billing profile.

### Reading the books

The journal and the balance cache are compared with `verify()` of the journal repository. A difference is a bug: stop and
look. **The journal check runs by itself**, once a day while billing is on: a step of the cron sweep (`journal_check`) and the
hourly timer of a server, a bounded part of the instance at a time (100 workspaces a step, 20 seconds a run), so a long
journal never blocks a run. The billing page shows **Journal check: ok (date)** or **inconsistent (date)**. It reports
only when a whole pass has finished; it is paused while billing is off. For each workspace that is not consistent
(the balance differs from the journal, the reserved money differs, or a hold of an ended job was never released) the log
has one line:

```
[billing] BILLING_JOURNAL_INCONSISTENT workspace=<id> balance_drift=<0|1> reserved_drift=<0|1> stranded_holds=<count>
[billing] BILLING_JOURNAL_CHECK_DONE result=<ok|inconsistent> workspaces=<n> inconsistent=<n>
```

No amount, name or address is in it. Alert on the first. The comparison is read-only, so it never repairs anything: look at
the workspace in the database. Besides it, do a read-only comparison in the database before and after each stage of the
rollout:

- the balance of each workspace against the sum of its entries;
- the open rows of `billing_webhook_events` (`review_state = 'open'`);
- the count of entries by type.

## 9. Switching off, and what to know first

Switching billing off is always allowed. It changes nothing else: the rates, the credentials, the journal and the balances
stay. Every billing route answers 404 again, reviews are not charged, and run quotas apply again.

**Do not switch billing off while top-ups are open.** The money routes answer 404 while billing is off, and Stripe retries a
failed delivery for about three days. A credit that arrives after that window is repaired only by "Check payment" or a
manual credit. Wait until no top-up is pending, or accept the repairs.

More things to know:

- A review that **started while billing was on and ends while it is off is not charged**, also if you switch billing on
  again. A review that started while billing was off is never charged.
- During a rolling deploy, a job claimed by new code and ended by old code is not charged. Avoid switching billing on in
  the middle of a deploy.
- Balances survive. Switching on again resumes from the same balance.
- The abuse brake and the monthly limit stop with billing.

## 10. Limits and open points

- **The journal check does not alert by itself.** It logs a stable code and shows its result on the billing page; the alert
  on `BILLING_JOURNAL_INCONSISTENT` is yours to set up in your log tooling.
- **Refund currency** under Adaptive Pricing (#604) and **invoices on Managed Payments** (#503) are not verified yet.
- **Many reviews at once on a small balance** can take it far below zero. That is accepted; the brake limits it.
- **No parking.** A refused review is not queued. The workspace tops up and pushes again.
- **Webhook events are not pruned.** The table grows by a few bytes per event.
