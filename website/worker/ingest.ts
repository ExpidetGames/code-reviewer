// SPDX-License-Identifier: LicenseRef-Proprietary

// Reverse-Proxy zu PostHog EU nach PostHogs Empfehlung
// (https://posthog.com/docs/advanced/proxy/cloudflare, .../proxy/proxy-reference):
//
//   /ingest/static/*, /ingest/array/*  →  eu-assets.i.posthog.com  (SDK-Skripte, im Cloudflare-Cache)
//   /ingest/*                          →  eu.i.posthog.com         (Events, Aufzeichnungen, Konfiguration)
//
// - Cookie und Authorization werden entfernt. PostHog braucht sie nicht: Besucher- und Session-ID schickt
//   das SDK im Event selbst mit, authentifiziert wird über den Projektschlüssel im Body.
// - X-Forwarded-For wird immer auf die Besucher-IP gesetzt. Ohne sie sieht PostHog nur Cloudflare-Adressen:
//   falsche Orte, und der anonyme Modus (Besucher-Hash aus IP und User-Agent) zählt falsch.
// - Alle anderen Header, der Pfad und die Suchparameter gehen unverändert durch.
const API_HOST = "eu.i.posthog.com";
const ASSET_HOST = "eu-assets.i.posthog.com";

export async function handleIngest(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/ingest/, "") || "/";
  const isAsset = path.startsWith("/static/") || path.startsWith("/array/");
  const host = isAsset ? ASSET_HOST : API_HOST;
  const target = `https://${host}${path}${url.search}`;

  if (isAsset) {
    const cache = (caches as unknown as { default: Cache }).default;
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(target);
    if (response.ok) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set("host", host);
  headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
}
