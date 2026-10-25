// SPDX-License-Identifier: LicenseRef-Proprietary

// Landing page copy, approved in docs/copy-plan.md of the former Next.js site (Itegro-GmbH/code-review-landing). Inline `code` is written with backticks.

export const HERO = {
  headlineLines: ["Simple code reviews", "for every GitHub", "pull request"],
  subheadline:
    "code-review.com reads each pull request when you open it and again after every push, then posts its findings as a comment. Built on PR-Agent and OpenCode, with the AI models included.",
  proof: [
    { label: "Nothing to install or run" },
    { label: "Built on PR-Agent and OpenCode" },
    { label: "Made in Germany by Itegro GmbH" },
  ],
} as const;

/** The product video in the hero (files in public/videos/, made by the product owner). */
export const DEMO_VIDEO = {
  mp4: "/videos/code-review-demo-v3.mp4",
  webm: "/videos/code-review-demo-v3.webm",
  poster: "/videos/code-review-demo-v3-poster.webp",
  posterJpg: "/videos/code-review-demo-v3-poster.jpg",
  label: "code-review.com in 26 seconds, a product video with voice",
  playLabel: "Watch the demo",
  durationLabel: "0:26",
  caption: "What code-review.com does, in 26 seconds. With sound.",
  fallback: "Your browser cannot play this video.",
  name: "code-review.com in 26 seconds",
  description:
    "How code-review.com reviews every GitHub pull request: automatic reviews when a pull request opens or changes, the /review comment and Review now.",
  uploadDate: "2026-10-25",
  duration: "PT26S",
} as const;

export const PROBLEM = {
  heading: "Your pull request is waiting. Again.",
  body: "You opened it before lunch. By the time someone looks, it is tomorrow, and the first comment is about a missing null check you would have caught yourself. code-review.com takes that first pass on every pull request, so your teammates can spend their review on design and intent instead of typos.",
} as const;

export type IconName =
  | "pullRequest"
  | "list"
  | "wallet"
  | "chat"
  | "github"
  | "agent";

export const BENEFITS: { title: string; body: string; icon: IconName }[] = [
  {
    title: "Every pull request gets reviewed.",
    body: "Reviews start when a pull request opens, is marked ready, or gets new commits. Drafts wait until you mark them ready.",
    icon: "pullRequest",
  },
  {
    title: "Short reviews you can act on.",
    body: "By default a review lists at most five findings. You can raise that to 30 per project, add your own project rules, and turn on inline comments.",
    icon: "list",
  },
  {
    title: "AI models included.",
    body: "We provide the models and take the price of each review from your prepaid credit. Choose the model per workspace or per project. Prefer your own provider key? You can use it instead.",
    icon: "wallet",
  },
  {
    title: "Ask for a review whenever you like.",
    body: 'Comment `/review` on a pull request, or press "Review now" in the app. Every run shows up with its status on the Runs page.',
    icon: "chat",
  },
];

// Two sentences of two lines each. From `sm` up every line fits the 680px cap at text-5xl and breaks where
// the thought breaks; on phones each sentence wraps balanced, so no word is left alone on a line.
export const TAGLINE_SENTENCES = [
  ["Every pull request", "gets a review."],
  ["Even the one you pushed", "on Friday at 6:47 pm."],
] as const;

export const STEPS: { title: string; body: string }[] = [
  {
    title: "Connect GitHub.",
    body: "Sign up, install the code-review.com GitHub App on the repositories you pick, and switch on the ones you want reviewed.",
  },
  {
    title: "Pick a model.",
    body: "Reviews run on our models and come out of your prepaid credit. New workspaces start with 2 USD. No API key needed.",
  },
  {
    title: "Open a pull request.",
    body: "The review arrives as a comment on the pull request. The Runs page in the app shows every review with its status, who started it, and a link to the comment.",
  },
];

export const PROOF = {
  heading: "What it is built on",
  items: [
    {
      title: "Standing on PR-Agent.",
      body: "Diff Review runs on PR-Agent by Qodo, a widely used review engine. code-review.com adds the GitHub App, workspaces, settings and the Runs page around it.",
      linkLabel: "PR-Agent on GitHub",
      link: "prAgent",
      icon: "github",
    },
    {
      title: "And OpenCode.",
      body: "Dynamic Review, our second engine, runs on OpenCode, a coding agent. It reads your repository, read only, rule files included.",
      linkLabel: "OpenCode on GitHub",
      link: "openCode",
      icon: "agent",
    },
  ],
  team: {
    title: "Made by three people near Munich.",
    body: "Itegro GmbH from Geretsried builds code-review.com.",
    linkLabel: "Meet the team",
  },
} as const;

export const RISK_REVERSAL = {
  title: "Nothing to cancel.",
  body: "No subscription and no automatic recharge. You only pay for the reviews that run.",
} as const;

export const FINAL_CTA = {
  heading: "Ready for your first review?",
  body: "Connect a repository, open a pull request, and see what code-review.com finds.",
} as const;
