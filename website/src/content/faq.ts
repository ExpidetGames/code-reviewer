// SPDX-License-Identifier: LicenseRef-Proprietary

// FAQ copy, approved in docs/copy-plan.md of the former Next.js site (Itegro-GmbH/code-review-landing). Rendered on the page and as FAQPage JSON-LD.

export const FAQ_HEADING = "Questions developers ask us";

export const FAQ: { q: string; a: string }[] = [
  {
    q: "What is code-review.com?",
    a:
      "code-review.com is a hosted service that reviews GitHub pull requests with AI. Diff Review runs PR-Agent on the changes of each pull request, Dynamic Review runs OpenCode and reads your repository. Both post the review as a comment.",
  },
  {
    q: "How does an AI code review on GitHub work?",
    a:
      "A GitHub App tells code-review.com when a pull request opens or changes. code-review.com queues a review job, a runner reads the changes of the pull request, asks the AI model for a review, and posts the result on the pull request.",
  },
  {
    q: "Which code hosts does it support?",
    a:
      "GitHub only, for now. It connects through a GitHub App that you install on the repositories you want reviewed.",
  },
  {
    q: "Which AI models can I use?",
    a:
      "The models we provide come with the service and are paid from your prepaid credit. You set the model for a whole workspace and can change it for single projects. Prefer your own provider key? You can use it instead.",
  },
  {
    q: "What happens to my code?",
    a:
      "To review a pull request, the runner reads its changes from GitHub and sends them to the AI provider of the model you chose. An own provider key, if you use one, is stored encrypted. Reviews run in fresh virtual machines in the region Frankfurt that end after the review, and we do not store your source code permanently.",
  },
  {
    q: "What does it cost?",
    a:
      "Prepaid credit: you top up a balance in US dollars and pay for each review when it ends, with no subscription. A review costs an AI part plus an infrastructure part. The details are on the pricing page.",
  },
  {
    q: "Do I have to install or run anything?",
    a:
      "No. You install the code-review.com GitHub App on the repositories you want reviewed. We run the reviews and provide the models.",
  },
  {
    q: "Can I start a review by hand?",
    a:
      'Yes. Comment `/review` on a pull request, or pick an open pull request in the app and press "Review now".',
  },
  {
    q: "Can I tell it about our coding rules?",
    a:
      "Yes. Each project has a field for extra instructions where you describe your rules in plain words, up to 4000 characters. They go into every review of that project.",
  },
  {
    q: "Does it replace human code review?",
    a:
      "No. It takes the first pass: bugs, missing checks, unclear code. A person still decides whether the change is right for your product.",
  },
  {
    q: "What is Dynamic Review?",
    a:
      "A second review engine built on OpenCode, a coding agent. It reads your repository, read only, including your rule files, so its reviews can follow your conventions.",
  },
  {
    q: "Who builds code-review.com?",
    a:
      "Itegro GmbH, a small software company from Geretsried near Munich. We built it because our own startup needed it, and now we run it as a hosted service for other teams.",
  },
];
