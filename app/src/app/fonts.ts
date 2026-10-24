// SPDX-License-Identifier: LicenseRef-Proprietary

import { Geist, Geist_Mono } from "next/font/google";

// Geist, the typeface of the landing page and the design board (#633). next/font downloads the files at
// build time and serves them from the app itself: the browser never asks Google. The variables feed
// `--font-sans` and `--font-mono` in theme.css. Shared by the root layout and the page for a crash in
// it (global-error.tsx), which replaces the layout and so has to bring the fonts itself (#637).
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

/** The class names for <html> that define the two font variables. */
export const fontVariables = `${geistSans.variable} ${geistMono.variable}`;
