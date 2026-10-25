// SPDX-License-Identifier: LicenseRef-Proprietary

// Pricing page copy, approved in docs/copy-plan.md of the former Next.js site (Itegro-GmbH/code-review-landing) (section 16).
// The model: prepaid credit in US dollars, no subscription, the price of a review is an AI part plus an
// infrastructure part. The markups behind the two parts are never published here; the app shows the final price of every review.

export const PRICING = {
  headingLines: ["Pay for the reviews", "you actually run"],
  lead: "Top up a balance in US dollars and every review takes its price from it when it ends. No subscription, no automatic recharge.",
  plansHeading: "How pricing works",
  vat: "Amounts are in US dollars. Credit is added without VAT; Stripe, our payment provider and the merchant of record, adds VAT at checkout where it applies.",
  business: "code-review.com is for businesses only.",
  termsLink: "Read the terms of service",
  action: "Start reviewing pull requests",
  ownKey: "Prefer your own provider key? You can use it instead and pay only the infrastructure part of each review.",
  faqHeading: "Questions about pricing",
} as const;

export type PricingPoint = {
  id: string;
  name: string;
  headline: string;
  note: string;
  summary: string;
  features: string[];
};

export const PRICING_POINTS: PricingPoint[] = [
  {
    id: "credit",
    name: "Prepaid credit",
    headline: "10 to 500 USD",
    note: "per top up, in US dollars",
    summary: "Top up your workspace balance when you need it. There is nothing to cancel.",
    features: [
      "No subscription, no base fee and no automatic recharge",
      "Credit never expires and is not refunded by us",
      "2 USD start credit, once per GitHub account",
      "Optional monthly spending limit",
    ],
  },
  {
    id: "review",
    name: "Price of a review",
    headline: "Two parts",
    note: "charged when a review ends",
    summary: "Each review costs an AI part plus an infrastructure part. You see both for every review in the app.",
    features: [
      "AI part: the model use of the review, on our models",
      "Infrastructure part: the compute time of the review, counted in started minutes",
      "The final price of each review is shown in the app once it has run",
      "Diff Reviews and Dynamic Reviews",
    ],
  },
];

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "How does prepaid credit work?",
    a:
      "You top up a balance for your workspace, between 10 and 500 US dollars at a time. Each review takes its price from the balance when it ends. There is no subscription, no base fee and no automatic recharge. Credit never expires. It is a prepayment for reviews, has no cash value and is not refunded by us, except in the cases the terms of service name, for example when you leave within 30 days of a price increase.",
  },
  {
    q: "What does a review cost?",
    a:
      "The price of a review has two parts. The AI part covers the model use and applies when the review runs on our models. The infrastructure part covers the compute time of the review, counted in started minutes. The app shows the final price of every review, split into both parts, once it has run. Prices can change; a new price applies only to reviews that start after we announce it in the app.",
  },
  {
    q: "Can I use my own provider key?",
    a:
      "Yes, as an option. With your own key at an AI provider you choose, your provider bills the model usage to you directly under its own terms. We charge only the infrastructure part of each review. You can switch between your own key and our models in the workspace settings.",
  },
  {
    q: "What happens when my credit runs out?",
    a:
      "A review starts as long as your balance is above zero, and its price is taken when it ends, so the balance can end slightly below zero. At zero or below, new reviews do not start: the pull request gets a notice and the Owners and Admins of the workspace are told. After you top up, push a new commit or comment `/review` to start a review.",
  },
  {
    q: "Can I limit what my workspace spends?",
    a:
      "Yes. Owners and Admins can set an optional monthly spending limit. When the charges of the month have reached it, new reviews do not start until the next month or until you raise the limit. Reviews that are already running always finish.",
  },
  {
    q: "Is there free credit to try it?",
    a: "New workspaces get a start credit of 2 US dollars, once per GitHub account.",
  },
  {
    q: "Who can buy, and how do I pay?",
    a:
      "code-review.com is for businesses. At your first top up you confirm that you buy for a business and give your company name and address, and optionally your VAT ID. You pay on the page of Stripe, our payment provider and the merchant of record. Stripe adds VAT at checkout where it applies and sends the receipt.",
  },
  {
    q: "What counts as a Dynamic Review?",
    a:
      "Dynamic Review is the second review engine, built on OpenCode. Instead of reading only the changes of a pull request, it reads your repository, read only, and follows your rule files. A Diff Review reads the changes of the pull request and posts its findings as a comment. The app shows the price of every review.",
  },
];
