// SPDX-License-Identifier: LicenseRef-Proprietary

// Links, calls to action, navigation and footer of the site. The copy itself follows the approved copy plan.
import { COMPANY } from "./company";

/** The application. Its sign-up and login pages are public routes of the app and read ph_did / ph_sid (see CROSS_DOMAINS in site.ts). */
export const APP_URL = "https://app.code-review.com";

export const LINKS = {
  signUp: `${APP_URL}/sign-up`,
  signIn: `${APP_URL}/login`,
  prAgent: "https://github.com/qodo-ai/pr-agent",
  openCode: "https://github.com/anomalyco/opencode",
  openCodeSite: "https://opencode.ai",
  itegro: COMPANY.web,
} as const;

/** Every "Start reviewing" call to action goes straight to the sign-up page of the app. */
export const CTA = {
  primary: "Start reviewing pull requests",
  header: "Start reviewing",
  href: LINKS.signUp,
} as const;

export type NavLink = { label: string; href: string; match?: string; location?: string };

/** Desktop island nav. `match` marks the link as the current page. */
export const NAV_LINKS: NavLink[] = [
  { label: "Product", href: "/", match: "/" },
  { label: "Pricing", href: "/pricing/", match: "/pricing" },
  { label: "FAQ", href: "/#faq" },
  { label: "About us", href: "/about/", match: "/about" },
  { label: "Sign in", href: LINKS.signIn, location: "nav" },
];

/** The expanded mobile menu has room for one more anchor. */
export const MENU_LINKS: NavLink[] = [
  { label: "Product", href: "/", match: "/" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Pricing", href: "/pricing/", match: "/pricing" },
  { label: "FAQ", href: "/#faq" },
  { label: "About us", href: "/about/", match: "/about" },
  { label: "Sign in", href: LINKS.signIn, location: "menu" },
];

export const FOOTER_COLUMNS: {
  title: string;
  links: { label: string; href: string; location?: string; consent?: boolean }[];
}[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/#how-it-works" },
      { label: "Pricing", href: "/pricing/" },
      { label: "FAQ", href: "/#faq" },
      { label: "Sign up", href: LINKS.signUp, location: "footer" },
      { label: "Sign in", href: LINKS.signIn, location: "footer" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "/about/" },
      { label: "Itegro GmbH", href: LINKS.itegro },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Imprint (Impressum)", href: "/imprint/" },
      { label: "Privacy policy", href: "/privacy/" },
      { label: "Terms of service", href: "/terms/" },
      { label: "Software licenses", href: "/licenses.txt" },
      // Reopens the consent dialog; only rendered when analytics are built in. Without JavaScript it is a plain link.
      { label: "Cookie settings", href: "/privacy/#analytics", consent: true },
    ],
  },
];
