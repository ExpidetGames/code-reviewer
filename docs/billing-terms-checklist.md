# Billing: checklist for the terms

This is for the person who writes the terms of service for an instance that sells reviews. It is a list of **points to
give a lawyer**. It is **not legal text** and not legal advice. Each point says what the product does, so the terms
match the product. It repeats the open points of the decision record
[0006](decisions/0006-prepaid-billing-via-stripe-managed-payments.md), section 6, with their status.

Read it together with [Billing: guide for the operator](billing.md). Where a number is shown it is made up.

## What the product does, in short

Prepaid pay-as-you-go in US dollars. One balance per workspace. A review takes its price from the balance when it ends.
Payments go through Stripe Managed Payments. Only businesses can buy. Credit never expires and we do not refund it.

## 1. The clauses the terms must carry

### Credit

- Credit is a **prepayment for reviews**. It has **no cash value**.
- It is **not transferable** between workspaces or people.
- It is **not refunded by us**.
- It has **no expiry**. (German case law has struck expiry clauses for self-paid prepaid balances, so the product does not
  expire credit.)
- The currency is **US dollars**. A top-up is between 10 and 500 dollars. There is no auto-recharge.
- The credit given for a payment is the amount **without VAT**. VAT is added at checkout.
- The balance belongs to the **workspace**, and all Owners and Admins of it can top up.
- A start credit may be given once per GitHub account. The operator may change or stop it.

### Who sells, and refunds

- **Stripe, through Link, is the merchant of record** for the payment. The buyer's payment, receipt and invoice come from
  Link. We receive a monthly self-billed invoice.
- **Stripe may refund within 60 days** whatever our policy says, and a buyer's bank may open a **dispute**.
- When a refund or a lost dispute takes back credit that was already spent, the **balance goes negative** and the
  **workspace is blocked** until it is positive again. The terms should say that the buyer owes the balance, or that the
  block stays until a top-up.
- The buyer may pay in a local currency. The credit is always in US dollars.

### Business customers only

- The app asks the buyer at the first top-up to confirm that it **buys for a business and not as a consumer**. The exact
  text today is: "I confirm that I am buying for a business and not as a consumer. Credit is a prepayment for reviews, has
  no cash value, cannot be transferred and is not refunded by us."
- The confirmation is stored with the time, the user and the **terms version** (`BILLING_TERMS_VERSION` in
  `app/src/billing/profile.ts`). **Change the version when the terms change.**
- The terms should state that the service is for businesses only, and what happens if the buyer is a consumer after all.
- An optional **VAT ID** can be given. The app only checks its shape. It does not check that the number is valid.

### What a review costs

- The price of a review is its **AI price** plus its **infrastructure price**. The AI price is the real model cost times a
  factor, on the operator's models only. The infrastructure price is the started minutes times a rate for the kind of
  review. There is no minimum price.
- The workspace sees the **two final prices** of each review. It does not see the factor, the rates, the minutes or the
  real cost. The terms should say that the operator sets the prices and may change them, and from when a change applies
  (reviews that end afterwards).
- A review on the **workspace's own provider key** pays the infrastructure price only. The provider bills the workspace for
  the model directly.
- A review **starts whenever the balance is above zero**. The price is taken when it ends and **may take the balance below
  zero**. The terms should say this, because a buyer can end below zero without any refund.

### Which reviews are charged

- A review whose **AI cost is unknown** (for example the provider did not report it) is charged its **minutes only**.
- A failure that is **clearly on our side** is **not charged**: the VM or Worker failed or crashed, our infrastructure was
  down, a timeout caused by us, the operator's key failed. Define "on our side" in the terms the same way the product does.
- A review that is **replaced by a newer commit is charged** (AI and minutes). If it fails with an error on our side it is
  free.
- A review that **failed, was stopped at a limit, ended without a result, or was cancelled** is charged in full unless the
  failure is clearly ours.
- A review that **never ran** (refused because the balance is empty, the monthly limit was reached, or cancelled while it
  waited) costs nothing.

### Limits and abuse

- A workspace may set a **monthly spending limit**. A new review is refused once the month's charges reach it. A review
  that runs is never stopped.
- There is a **hidden hourly limit** on how many reviews a workspace may start. The terms should say that the operator may
  pause reviews for a workspace to prevent abuse, without naming the number.
- The operator may refuse or pause service for abuse of the start credit or of the service.

### Invoices and tax

- Invoices and receipts are **issued by Link**. **Promise nothing about VAT-compliant invoices** until the sandbox check
  (#503) has passed. The product says only that Link issues and emails them.
- Say who is responsible for the buyer's VAT treatment (reverse charge for a business buyer in another EU country, and so
  on) in the way your tax advisor confirms.

### Data held

- The **billing profile** (legal name, address, optional VAT ID) and the **business confirmation** are stored per
  workspace. They are visible only to Owners and Admins, never logged, and sent only to Stripe.
- The **journal** keeps every top-up, charge, refund and correction with dates, and each review's AI price and
  infrastructure price. It cannot be edited or deleted.
- Stripe keeps the payment data. Stripe may delete its objects on a buyer's data request, so the journal keeps only opaque
  ids and our own amounts.
- The privacy text must name the **billing profile** and **Stripe**.
- **Open:** a workspace with a journal entry cannot be deleted by the app, because the journal is immutable. Decide how
  erasure requests meet the ledger before workspace deletion is built.

### Ending the service

- Say what happens to unused credit if the operator ends the service or switches billing off. Switching off keeps balances;
  the product has no refund path.
- The terms link: the business confirmation needs a link to the terms. Enter it (and, optionally, the link to the privacy
  statement) on the billing page of the admin portal (card **Terms and privacy**): an `https` address of a public website. With
  Stripe, billing cannot be switched on without it (`terms_url_missing`).

## 2. The open points of ADR 0006, section 6

| #  | Question                                                                 | Status                                                                                                                                                  |
| -- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Is the start credit USD 2?                                               | **Decided** (2026-10-19): yes, 2 dollars. It is an admin setting.                                                                                       |
| 2  | "An error on our side" at the edges (`timeout`, `no_result`)             | **Decided** (2026-10-19): a timeout caused by us is free. `no_result`, failures and cancellations are charged in full. An unknown AI cost is charged minutes only. |
| 3  | Are plan run quotas removed only while billing is on?                    | **Decided**: only while billing is on. With billing off, workspaces keep their monthly review limits. The operator API limits stay.                      |
| 4  | Is the workspace's own key-mode choice the meaning of "two modes share one balance"? | **Decided**: the workspace chooses. The default is the operator's key.                                                                      |
| 5  | Is an admin-set hold acceptable for Diff?                                | **Moot**: there are no holds any more (2026-10-21). A review starts at any positive balance.                                                            |
| 6  | Refund policy and the terms (German AGB control between businesses)      | **Open, maintainer task**: "not refunded by us" needs a legal review before go-live. Stripe refunds within 60 days anyway.                              |
| 7  | USD ledger against EUR settlement and Adaptive Pricing                   | **Accepted** (2026-10-19): the currency risk is ours.                                                                                                   |
| 8  | VAT on prepaid credit, and VAT ID treatment of German business buyers    | **Open, tax advisor**: single- or multi-purpose voucher; reverse charge (13b UStG).                                                                     |
| 9  | Does Stripe accept closed-loop credit?                                   | **Open**: the maintainer decided not to ask first. The live purchase test is the first real signal. Stripe may later object to a stored balance.        |
| 10 | The rates                                                                | **Decided by the maintainer** (not in the repository). Set in the admin portal.                                                                         |

## 3. Before go-live

- A lawyer has read the terms, including "not refunded by us", the negative balance, and the business-only declaration.
- The privacy text names the billing profile and Stripe.
- A tax advisor has confirmed VAT on prepaid credit and the bookkeeping from the self-billed invoice.
- The terms have a version and a link, and the app shows the link next to the confirmation.
- The price display (the AI part and the infrastructure part of each review) is what the terms describe.
