# Changelog der Vorlage

Jede Landingpage trägt in `package.json` unter `itegroVorlage` die Version, mit der sie gestartet ist.
Änderungen, die bestehende Seiten nachziehen sollten, sind mit **Nachziehen** markiert.

## 1.0.1 (2026-10-25)

- Node fest auf `24.21.0` in `.nvmrc`, pnpm über `packageManager`. Cloudflare braucht keine Variablen
  `NODE_VERSION`/`PNPM_VERSION` mehr. **Nachziehen:** bei bestehenden Seiten die Variablen im Dashboard löschen
  und die Versionen in die Dateien schreiben.

## 1.0.0 (2026-10-25)

Erste Version.

- Astro 7, statischer Build, Tailwind 4, Content Collections für den Blog
- SEO: Titel, Beschreibung, Canonical, Open Graph mit erzeugtem Vorschaubild pro Seite, strukturierte Daten
  (Organization, WebSite, BlogPosting, BreadcrumbList, FAQPage), Sitemap mit Änderungsdaten, RSS, robots.txt,
  llms.txt
- Cloudflare Workers mit Static Assets, PostHog-Proxy unter `/ingest`, Sicherheits-Header, noindex für
  workers.dev
- Tracking nach Prozess „Landingpages“: Klaro, PostHog erst nach der Wahl, Do Not Track/GPC als Ablehnung,
  seitenübergreifendes Tracking (`SHARED_COOKIE_DOMAIN`, `CROSS_DOMAINS`)
- Prüfskript für den fertigen Build (`pnpm verify`)
