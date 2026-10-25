// SPDX-License-Identifier: LicenseRef-Proprietary

// About us copy, approved in docs/copy-plan.md of the former Next.js site (Itegro-GmbH/code-review-landing) (section 13).

export const ABOUT = {
  headingLines: ["We build the tools", "we were missing"],
  subheading: "We are Itegro GmbH, a small software company from Geretsried, just south of Munich.",
  photo: {
    src: "/images/founders.webp",
    width: 2048,
    height: 1365,
    alt: "Luca Schackmann, Vincent Helmers and Lukas Laschinger, the founders of Itegro GmbH, standing in front of a white wall. Two of them make finger gun poses, the one in the middle has arms crossed.",
    caption: "Our serious company photo. We tried.",
  },
  sections: [
    {
      heading: "Three people, one company",
      paragraphs: [
        "There are three of us: Luca Schackmann, Vincent Helmers and Lukas Laschinger. We founded Itegro together and all three of us are managing directors, so there is never a boss to blame.",
      ],
    },
    {
      heading: "What we do",
      paragraphs: [
        "We build software of all kinds: apps, websites, SaaS products. For a long time we mostly built things we never used ourselves. Good work, but a bit like cooking every day and never eating.",
      ],
    },
    {
      heading: "Our rule",
      paragraphs: [
        "So we made a rule. When our own startup is missing something and we cannot find a tool that fits, we build it ourselves. Then we turn it into a simple hosted service for everyone who has the same problem.",
        "That is how code-review.com came to be.",
      ],
    },
  ],
  closing: "Want to see what else we build? Visit",
} as const;
