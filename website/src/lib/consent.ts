// SPDX-License-Identifier: LicenseRef-Proprietary

// Klaro verwaltet die Einwilligung (Cookie <SITE>_klaro, bei SHARED_COOKIE_DOMAIN für alle Subdomains). PostHog startet erst, wenn sie feststeht:
//   - gespeicherte Entscheidung beim Seitenaufruf  → sofort im passenden Modus
//   - Entscheidung im Banner                       → beim Speichern („saveConsents“)
//   - Do Not Track / Global Privacy Control        → kein Banner, anonymer Modus; über den Footer-Link
//                                                    kann trotzdem eingewilligt werden
// Achtung: Klaros service.callback läuft auch OHNE Entscheidung (mit false). Deshalb hier nicht nutzen,
// sondern manager.confirmed und den Watcher.
import klaroCss from "klaro/dist/klaro.min.css?url";
import { analyticsEnabled, startAnalytics, takeCrossDomainIds } from "./analytics";
import { SHARED_COOKIE_DOMAIN, SITE } from "../site";

type Klaro = typeof import("klaro/dist/klaro-no-css");

const SERVICE = "posthog";

function hasPrivacySignal(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

function buildConfig(noAutoLoad: boolean) {
  return {
    elementID: "klaro",
    storageMethod: "cookie",
    // Fall A (Subdomains): ein Cookie für alle Subdomains, mit demselben Namen auf jeder Seite.
    ...(SHARED_COOKIE_DOMAIN
      ? { cookieName: "itegro_consent", cookieDomain: `.${SHARED_COOKIE_DOMAIN}` }
      : { cookieName: `${SITE}_klaro` }),
    cookieExpiresAfterDays: 180,
    privacyPolicy: "/privacy/#analytics",
    default: false,
    mustConsent: false,
    acceptAll: true,
    hideDeclineAll: false,
    hideLearnMore: false,
    disablePoweredBy: true,
    noAutoLoad,
    lang: "en",
    translations: {
      // The copy is English (the legal texts also have a German version); the policy names these buttons.
      en: {
        consentNotice: {
          description:
            "We use PostHog, hosted in the EU, to see how visitors use this site. Accept: a cookie with a random ID, " +
            "plus clicks, scrolling and session recordings with all inputs masked, heatmaps and short surveys. " +
            "Decline: page views are counted without cookies and nothing is stored on your device. " +
            "The site works the same either way.",
          learnMore: "Settings",
        },
        consentModal: {
          title: "Analytics on this site",
          description:
            "You can change your choice at any time. Changing it deletes the analytics data stored on your device and reloads the page.",
        },
        posthog: {
          title: "PostHog (analytics)",
          description:
            "Recognises returning visits and records how the site is used, so we can find errors and hurdles. " +
            "Inputs are masked.",
        },
        purposes: { analytics: "Analytics" },
        ok: "Accept",
        acceptAll: "Accept",
        acceptSelected: "Save selection",
        decline: "Decline",
        save: "Save",
        close: "Close",
        privacyPolicy: { name: "privacy policy", text: "Read our {privacyPolicy}." },
      },
    },
    services: [{ name: SERVICE, purposes: ["analytics"], default: false, required: false, optOut: false }],
  };
}

let klaro: Klaro | null = null;
let config: ReturnType<typeof buildConfig> | null = null;

/** Einmal pro Seite aufrufen (Base.astro macht das). */
export async function setupConsent(): Promise<void> {
  if (!analyticsEnabled || klaro) return;
  takeCrossDomainIds();
  // Klaro samt CSS erst laden, wenn Tracking überhaupt aktiv ist.
  const stylesheet = Object.assign(document.createElement("link"), { rel: "stylesheet", href: klaroCss });
  document.head.append(stylesheet);
  const mod = await import("klaro/dist/klaro-no-css");
  klaro = ((mod as { default?: Klaro }).default ?? mod) as Klaro;

  const signal = hasPrivacySignal();
  config = buildConfig(signal);
  const manager = klaro.getManager(config);

  manager.watch({
    update(m, name) {
      if (name === "saveConsents") void startAnalytics(m.getConsent(SERVICE) ? "full" : "anonymous");
    },
  });

  if (manager.confirmed) void startAnalytics(manager.getConsent(SERVICE) ? "full" : "anonymous");
  else if (signal) void startAnalytics("anonymous");

  klaro.setup(config);
}

/** For the footer link "Cookie settings". */
export async function showConsentSettings(): Promise<void> {
  await setupConsent();
  if (klaro && config) klaro.show(config, true);
}
