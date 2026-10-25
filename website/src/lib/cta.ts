// SPDX-License-Identifier: LicenseRef-Proprietary

// Event cta_clicked: a visitor opens a link to the app (sign up or login). Properties: `target` (the page of the app:
// "sign-up" or "login") and `location` (where on the page: hero, nav, menu, pricing, about, footer, final-cta).
// Like every custom event it is only sent with consent (track() in analytics.ts); the ids for the app are appended to
// the link by the cross-domain decoration in analytics.ts (CROSS_DOMAINS in site.ts). Right click sends nothing.
import { track } from "./analytics";
import { CROSS_DOMAINS } from "../site";

const APP_HOSTS = CROSS_DOMAINS.filter((domain) => domain.startsWith("app."));

export function setupCtaTracking(): void {
  const send = (event: MouseEvent) => {
    // click covers left click, Ctrl/Cmd click and Enter; auxclick only the middle button.
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || !APP_HOSTS.includes(link.hostname)) return;
    const target = link.pathname.replace(/^\/|\/$/g, "") || "app";
    const location = link.closest("[data-cta-location]")?.getAttribute("data-cta-location") ?? "page";
    track("cta_clicked", { target, location });
  };
  document.addEventListener("click", send, true);
  document.addEventListener("auxclick", send, true);
}
