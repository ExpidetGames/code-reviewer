// SPDX-License-Identifier: LicenseRef-Proprietary

// PostHog EU über den eigenen Proxy (/ingest). posthog-js wird erst geladen, wenn die Einwilligung
// feststeht (src/lib/consent.ts). Zwei Modi, für einen Seitenaufruf fest:
//   full       „Akzeptieren“: Cookie + localStorage, Autocapture, Session Replay (Eingaben maskiert),
//              Heatmaps, Umfragen, Web Vitals, Fehler, Seitenaufrufe.
//   anonymous  „Ablehnen“, Do Not Track, Global Privacy Control: cookieless_mode "always". Nichts auf dem
//              Gerät, nur Seitenaufrufe, gezählt über PostHogs Besucher-Hash. Braucht in PostHog
//              Project Settings → Web analytics → „Cookieless server hash mode“.
// Ändert sich die Wahl später, wird alles von PostHog Gespeicherte gelöscht und die Seite neu geladen.
//
//
// Alle Landingpages laufen im PostHog-Hauptprojekt: jedes Event trägt `site` (SITE) zum Filtern.
// Seitenübergreifend (nur voller Modus), eingestellt in site.ts:
//   SHARED_COOKIE_DOMAIN  Subdomains teilen sich das PostHog-Cookie.
//   CROSS_DOMAINS         Links zu diesen Domains bekommen Besucher- und Session-ID als URL-Parameter,
//                         die Zielseite übernimmt sie per `bootstrap`.
import { CROSS_DOMAINS, SHARED_COOKIE_DOMAIN, SITE } from "../site";

const KEY: string = import.meta.env.PUBLIC_POSTHOG_KEY ?? "";

const PARAM_DISTINCT_ID = "ph_did";
const PARAM_SESSION_ID = "ph_sid";
const PARAM_TIMESTAMP = "ph_ts";
/** Übernommene IDs dürfen höchstens so alt sein. Schützt vor weitergegebenen oder gespeicherten Links. */
const MAX_LINK_AGE_MS = 2 * 60 * 1000;

/** Ohne Schlüssel beim Build: kein Banner, kein Tracking, kein Footer-Link. */
export const analyticsEnabled = KEY.length > 0;

export type AnalyticsMode = "full" | "anonymous";

type PostHog = typeof import("posthog-js").default;
type PostHogConfig = NonNullable<Parameters<PostHog["init"]>[1]>;

const ANONYMOUS_EVENTS = new Set(["$pageview", "$pageleave"]);

const baseConfig: Partial<PostHogConfig> = {
  api_host: "/ingest",
  ui_host: "https://eu.posthog.com",
  defaults: "2026-01-30",
  capture_pageview: "history_change",
  capture_pageleave: true,
  person_profiles: "identified_only",
  // Do Not Track / GPC behandelt consent.ts (anonymer Modus statt gar nichts).
  respect_dnt: false,
};

const fullConfig: Partial<PostHogConfig> = {
  persistence: "localStorage+cookie",
  // true: Cookie auf der Hauptdomain, für alle Subdomains (PostHog ermittelt die Hauptdomain selbst).
  cross_subdomain_cookie: SHARED_COOKIE_DOMAIN !== null,
  cookie_expiration: 365,
  autocapture: true,
  rageclick: true,
  capture_heatmaps: true,
  capture_dead_clicks: true,
  capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true },
  capture_performance: { web_vitals: true, network_timing: true },
  disable_session_recording: false,
  session_recording: {
    maskAllInputs: true,
    // Text in Elementen mit data-sensitive wird maskiert, .ph-no-capture blendet Elemente ganz aus.
    maskTextSelector: "[data-sensitive]",
    blockSelector: ".ph-no-capture",
  },
  disable_surveys: false,
};

const anonymousConfig: Partial<PostHogConfig> = {
  cookieless_mode: "always",
  person_profiles: "never",
  autocapture: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  // Nur die beiden Zähl-Events verlassen in diesem Modus den Browser.
  before_send: (event) => (event && ANONYMOUS_EVENTS.has(event.event) ? event : null),
};

let current: AnalyticsMode | null = null;
let instance: PostHog | null = null;
let incoming: { distinctID: string; sessionID?: string } | null = null;

/**
 * Liest Besucher- und Session-ID einer anderen Seite aus der URL und entfernt sie sofort daraus, damit sie
 * weder in Lesezeichen noch in Seitenaufrufen landen. Übernommen werden sie nur, wenn der Link frisch ist
 * (ph_ts, höchstens MAX_LINK_AGE_MS alt), und nur im vollen Modus.
 * Vor dem Laden von PostHog aufrufen (consent.ts macht das).
 */
export function takeCrossDomainIds(): void {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  if (!params.has(PARAM_DISTINCT_ID) && !params.has(PARAM_SESSION_ID) && !params.has(PARAM_TIMESTAMP)) return;
  const distinctID = params.get(PARAM_DISTINCT_ID);
  const sessionID = params.get(PARAM_SESSION_ID);
  const age = Date.now() - Number(params.get(PARAM_TIMESTAMP));
  for (const name of [PARAM_DISTINCT_ID, PARAM_SESSION_ID, PARAM_TIMESTAMP]) params.delete(name);
  window.history.replaceState(window.history.state, "", url);
  if (distinctID && age >= 0 && age <= MAX_LINK_AGE_MS) incoming = { distinctID, sessionID: sessionID ?? undefined };
}

const isCrossDomain = (host: string) =>
  host !== window.location.hostname &&
  CROSS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Hängt beim Klick auf einen Link zu CROSS_DOMAINS die eigenen IDs an (nur voller Modus) und stellt den Link
 * gleich danach wieder her. Nur bei echtem Öffnen (click: Linksklick, Strg/Cmd-Klick, Enter; auxclick:
 * Mittelklick), nie beim Rechtsklick: Ein per „Link kopieren“ weitergegebener Link würde sonst die eigene
 * Besucher-ID an andere Personen weitergeben.
 */
function decorateCrossDomainLinks(posthog: PostHog): void {
  if (CROSS_DOMAINS.length === 0) return;
  const decorate = (event: MouseEvent) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || !isCrossDomain(link.hostname)) return;
    const original = link.href;
    const url = new URL(original);
    url.searchParams.set(PARAM_DISTINCT_ID, posthog.get_distinct_id());
    url.searchParams.set(PARAM_SESSION_ID, posthog.get_session_id());
    url.searchParams.set(PARAM_TIMESTAMP, String(Date.now()));
    link.href = url.toString();
    // Die Navigation hat die URL beim Auslösen schon übernommen; danach wieder den sauberen Link zeigen.
    setTimeout(() => {
      link.href = original;
    }, 0);
  };
  document.addEventListener("click", decorate, true);
  document.addEventListener("auxclick", decorate, true);
}

/** Entfernt alles, was PostHog in Cookies, localStorage und sessionStorage abgelegt hat. */
export function clearPostHogStorage(): void {
  const isPostHog = (name: string) => name.startsWith("ph_") || name.startsWith("__ph");
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[area];
      for (const key of Object.keys(storage)) if (isPostHog(key)) storage.removeItem(key);
    } catch {
      // Speicher blockiert: dann konnte PostHog dort auch nichts ablegen.
    }
  }
  const host = window.location.hostname;
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim() ?? "";
    if (!isPostHog(name)) continue;
    const domains = ["", `; domain=${host}`, `; domain=.${host}`];
    if (SHARED_COOKIE_DOMAIN) domains.push(`; domain=.${SHARED_COOKIE_DOMAIN}`);
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
    }
  }
}

/** Startet PostHog im gewählten Modus. Ein Wechsel nach dem Start löscht alles und lädt neu. */
export async function startAnalytics(mode: AnalyticsMode): Promise<void> {
  if (!analyticsEnabled) return;
  if (current !== null) {
    if (current !== mode) {
      clearPostHogStorage();
      window.location.reload();
    }
    return;
  }
  current = mode;
  if (mode === "anonymous") clearPostHogStorage();
  const { default: posthog } = await import("posthog-js");
  const bootstrap = mode === "full" && incoming ? { bootstrap: { ...incoming, isIdentifiedID: false } } : {};
  posthog.init(KEY, { ...baseConfig, ...(mode === "full" ? fullConfig : anonymousConfig), ...bootstrap });
  posthog.register({ site: SITE });
  instance = posthog;
  if (mode === "full") decorateCrossDomainLinks(posthog);
}

/**
 * Eigenes Event, z. B. track("cta_clicked", { position: "hero" }). Wird nur im vollen Modus gesendet
 * (nach „Akzeptieren“); sonst passiert nichts. Keine personenbezogenen Daten als Eigenschaften.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (current === "full") instance?.capture(event, properties);
}
