# Billing for self-hosters

**Billing is off by default, and if you never switch it on, nothing changes for you.** This page says what stays inert,
what the `manual` adapter is, and what changes when you turn billing on for your own instance.

If you sell reviews and take payments with Stripe, read [Billing: guide for the operator of a hosted
instance](billing.md) instead. This page assumes you either do not want billing, or want a prepaid balance without a
payment provider.

All numbers on this page are made up.

## 1. If you do not switch billing on

You do nothing. Specifically:

- **No setting, no variable.** Billing has no environment variable. It is configured only in the admin portal, menu
  **Billing**. `.env.example` and the Compose files are unchanged.
- **Every billing route answers 404** as if it did not exist: the webhook, the top-up, the journal, the billing details,
  the monthly limit and the workspace page. The page `Settings, Plan` is the plan page you know.
- **No billing table is read or written** when a job is claimed or finished, and no payment provider is called. The
  usage records, the claim and the operator feed are exactly as before.
- **Your monthly review limits stay.** The per-period run quotas of the entitlements (epic #268) keep working. They are
  dropped only while billing is on.
- **Opening the Billing page changes nothing.** It reads and shows. It calls nobody.

What billing off still does, so you are not surprised:

- The app reads one instance setting (`billing_settings`) on a claim, on the end of a job, and when a stop call is
  answered. This is a single small read.
- A Dispatcher's claim is noted at most once an hour (which kind of Dispatcher it is), so that the admin page can check it
  before billing is switched on. This only applies to the hosted deployment.
- The VM records of the hosted deployment (one row per VM) are stored whether or not billing is on.

## 2. The `manual` adapter

The `manual` adapter is for an instance that wants a **prepaid balance without a payment provider**. You, the instance
admin, put credit on a workspace by hand. A company could use it to charge internal teams, for example, and settle outside
the app.

- **No checkout and no webhook.** The workspace page has no "Add credit" form. It says to ask the operator.
- **You add credit** on the admin page **Billing**: search the workspace, choose **credit** or **correction**, type the
  amount and a note (up to 500 characters). A credit is a top-up entry, a correction can be positive or negative and may
  take a balance below zero. An amount is at most 10,000 dollars at once. Every entry has an actor and a note, so the
  journal is your audit trail.
- It works whether billing is on or off, and with either adapter.
- A repeated click is one entry (the request has an id).

## 3. Turning billing on

You only need this if you want charging. In the admin portal, menu **Billing**:

1. Pick the adapter. `manual` is the default.
2. Set **Factor A** and one **rate per started minute** for Diff and for Dynamic reviews. There is no default. Set the
   **AI reserve per Diff review** too: it is a leftover and any value in range is fine, but it is required.
3. Set the other numbers if you do not like the defaults: the start credit (2 dollars, 0 turns it off), the low-balance
   threshold (5 dollars) and the hourly review limit per workspace (60).
4. Read the statement and switch billing on. If something is missing the page names it.

Billing is on only when the switch is set **and** the adapter is ready. For `manual` that means the three rates and the
reserve are set.

### What changes when it is on

- **Workspaces are charged from a prepaid balance** in US dollars. A review costs its AI cost times A (only on your
  models) plus its started minutes times the rate of its kind.
- **A review starts when the balance is above zero.** The price is taken when the review ends and may take the balance
  below zero. At zero or below no review starts, and the pull request gets one notice.
- **The start credit** is granted to a workspace the first time it meets billing, once per GitHub account. Set it to 0 if
  you do not want to give one.
- **Key mode.** Every workspace chooses **your models** (the default) or **its own provider key**. On its own key it pays
  infrastructure only. A workspace with no balance cannot start a review, except on its own key at a rate of 0.
- **No run quotas.** The per-period quotas of the entitlements are not applied while billing is on. The operator API
  limits stay.
- **Limits.** A workspace may set its own monthly spending limit. The hourly brake caps how many reviews a workspace
  starts in an hour.
- **Notifications.** Owners and Admins get one mail when the balance is low and one when it is empty, and see a banner.
  The mails need a mail server in the admin portal.
- **The settings navigation** shows **Billing** instead of **Plan**.

### Minutes on your own machines

The infrastructure price is **started minutes times the rate**. On a hosted deployment the minutes are the VM's life. On
**Compose and any server without a VM** there is no VM to measure. The app then uses the job's **wall clock on the
runner**, from the claim to the end. If you do not want to charge for it, set the rate to 0 for that kind. A job on
its own key whose rate is 0 costs nothing and can start even at a balance of exactly zero.

### Who pays when a review fails

Free only when the failure is clearly yours (your runner or infrastructure failed, a crash, a timeout, or your
own key failing on the managed key). Everything else is charged. A review whose AI cost is unknown is charged its minutes only.
The full table is in [the operator guide](billing.md), section 1.

### Switching off

You can switch billing off any time. Rates, credentials, the journal and the balances stay. Reviews are not charged, the
billing routes answer 404 again and the run quotas apply again. A review that started while billing was on and ends while it
is off is not charged. Switching on later resumes from the same balance.

## 4. Using Stripe on your own instance

You can use the `stripe` adapter with your own Stripe account. Everything in [the operator
guide](billing.md) applies: Managed Payments enrollment and eligibility are Stripe's decisions for your business, the
webhook route must be reachable from the internet over https, and you need terms ([checklist](billing-terms-checklist.md)).
The Stripe key and the webhook secret are saved in the admin portal, never in an environment variable.

Two variables exist for tests only: `STRIPE_API_BASE_URL` and `ALLOW_TEST_STRIPE_ENDPOINTS`. They point the app at a fake
Stripe. The address is ignored without the flag, and even with it only a plain `http` address on the loopback is accepted.
Do not set them on a real instance.

## 5. Quick answers

| Question                                           | Answer                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Does billing cost me anything if it is off?        | No. No billing table is read, no one is called.                                                      |
| Do my monthly review limits still work?            | Yes, while billing is off. They are dropped only while it is on.                                     |
| Can I give credit without Stripe?                  | Yes, with the `manual` adapter, from the admin portal.                                               |
| Can I turn it off again?                           | Yes. Balances stay.                                                                                  |
| Does it send data anywhere?                        | Not with `manual`. With `stripe`, the billing details a workspace types go to Stripe and nowhere else. |
| Where is the code?                                 | `app/src/billing/README.md`                                                                          |
