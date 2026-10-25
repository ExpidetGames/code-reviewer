# code-review.com landing page

The marketing site of [code-review.com](https://code-review.com): home, pricing, about us, imprint, privacy policy and
terms of service. An Astro site built from the Itegro template (`Itegro-GmbH/landingpage-vorlage`, version in
`package.json` under `itegroVorlage`, changes of the template in [CHANGELOG.md](CHANGELOG.md)), built statically and
hosted on Cloudflare Workers with static assets. It is its own pnpm project: nothing in `app/`, `runner/` or
`dispatcher/` depends on it. The hosted application lives in `app/` and runs on its own domain,
`app.code-review.com`.

> **Not open source:** code-review.com is a hosted service and cannot be self-hosted. The repository is source-visible
> only (see the `LICENSE` in the repository root). No page of the site may call the product open source or offer
> self-hosting.

How the site is built and hosted follows the process "Landingpages" in `Itegro-GmbH/itegro-gmbh`
(`prozesse/landingpages/README.md`); rules for agents and contributors are in [AGENTS.md](AGENTS.md).

## Develop

Node 24 (`.nvmrc`) and pnpm 10.33.0 (`packageManager`).

```sh
cd website
pnpm install --frozen-lockfile
pnpm dev            # http://localhost:4321, without /ingest and without tracking
pnpm verify         # types, legal Markdown check, build and build check; before every commit
pnpm preview        # build + wrangler dev: like production, with /ingest, _headers, _redirects and the 404
```

Without `PUBLIC_POSTHOG_KEY` at build time the site has no consent banner, no tracking and no "Cookie settings" link
(what you want for `pnpm dev`). To try the tracking locally, copy `.env.example` to `.env.local`, set the key and run
`pnpm preview` (use `pnpm exec wrangler dev --port <free port>` after `pnpm build` on a shared machine). That sends
real events to the PostHog main project.

CI: the job `website` of `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` and `pnpm verify` for every
change under `website/` and is part of the required check "All checks passed?". The heavy jobs of `ci.yml` (app, runner,
dispatcher, images) skip such changes; the `licenses` job still runs, with the SPDX check and the scans of the whole tree.

## What is where

See the table in [AGENTS.md](AGENTS.md#where-things-are). In short: the copy is in `src/content/`, the pages in
`src/pages/`, the tracking in `src/lib/` and `worker/`, the legal texts in `src/content/privacy.ts` and `terms.ts`
(with Markdown copies for review in `legal/`, `pnpm legal:md`).

Things that are easy to break:

- **Legal URLs.** `/imprint/`, `/privacy/` and `/terms/` are linked from the app; `/impressum`, `/datenschutz` and
  `/agb` redirect to them (`public/_redirects`).
- **Terms version.** `TERMS_VERSION` in `src/content/terms.ts` is `2026-10-24`. The app stores the version a customer
  confirmed (`BILLING_TERMS_VERSION`); change both together.
- **Blog.** The blog is scaffolded but empty, and an empty blog is invisible (no `/blog/` page, no link, no sitemap
  entry). Add the first real article as `src/content/blog/<url>.md` and it all appears.
- **Tracking and the privacy policy** describe the same behaviour: change them together.

## Hosting: Cloudflare Workers (static assets)

The build (`pnpm build`) writes the site to `dist/`. `wrangler.jsonc` serves it as static assets; the only Worker code
is `worker/` and it answers only `/ingest/*`, the first-party PostHog proxy (`run_worker_first`). Everything else,
including `public/_headers` (Content-Security-Policy and more) and `public/_redirects`, is handled by the assets.

Set up the Workers project once (the Worker is named `code-review-landing`, the `name` in `wrangler.jsonc`; it must
match the Worker in the Cloudflare dashboard):

1. Cloudflare → **Workers & Pages** → the existing Worker `code-review-landing` → **Settings** → **Build**
   → connect the repository `Itegro-GmbH/code-reviewer` instead of `Itegro-GmbH/code-review-landing`. **Production
   branch:** `main` (decided by the owner), so a change to the site goes live with the next release of this repository
   (`development` → `main`); to publish a site change earlier, release it like a hotfix. **Branch control → builds for
   non-production branches: off**, so `development` and feature branches publish nothing and build no preview (if previews
   are ever switched on, they have no `PUBLIC_POSTHOG_KEY` and no tracking, and `workers.dev` addresses send
   `X-Robots-Tag: noindex`, see below).
2. **Root directory:** `website`. **Build command:** `pnpm build`. **Deploy command:** `npx wrangler deploy`.
3. **Build variables and secrets:** `NODE_VERSION` = `24`, `PNPM_VERSION` = `10.33.0`, and
   `PUBLIC_POSTHOG_KEY` = the key of the PostHog main project (vault entry "Posthog Landingpage Key"), for
   **production builds only**, so previews never track. The key is inlined at build time: build again after changing it.
4. **Build watch paths** (Build → Build watch paths): include `website/*` so only changes to the site build it.
5. **Custom domain** `code-review.com` (Settings → Domains & Routes) stays on this Worker; `www` → apex is a Redirect
   Rule in the zone (301, keep path and query), as before.
6. Keep these Cloudflare settings off, the privacy policy relies on it: Web Analytics, Email Address Obfuscation,
   Rocket Loader, Bot Fight Mode (it sets a cookie), Zaraz, and Logpush of request logs.

`*.workers.dev` and preview addresses send `X-Robots-Tag: noindex`.

## Tracking

Per the process: the **PostHog main project (EU)** shared by all Itegro landing pages, every event with
`site = "code-review"`. Klaro asks first (English); PostHog is not loaded before a decision. "Accept": cookie
`ph_<key>_posthog`, autocapture, session replay with masked inputs, heatmaps, rage and dead clicks, errors, web vitals,
surveys. "Decline", Do Not Track and Global Privacy Control: cookieless, pseudonymous counting (page views and leaves
only). The Klaro cookie is `code-review_klaro` (180 days); "Cookie settings" in the footer changes the choice.

- **Linking with itegro-gmbh.de:** `CROSS_DOMAINS` in `src/site.ts`. A consented visitor who opens a link there carries
  `ph_did`, `ph_sid` and `ph_ts` along (appended at the moment the link is opened and removed again right after;
  nothing on right click), and ids arriving from another Itegro page are taken over if the link is at most 2 minutes old.
- **Hand-over to the app:** the same mechanism for `app.code-review.com`, which is why it is in `CROSS_DOMAINS` too.
  The contract with the app: query parameters `ph_did` and `ph_sid` (plus `ph_ts`, ignored) on
  `https://app.code-review.com/sign-up` and `/login`; the app stores them with the new account and runs no
  analytics SDK. Consented visitors only.
- **`cta_clicked`** `{ target, location }` is captured when a consented visitor opens a link to the app
  (`src/lib/cta.ts`); `target` is the page of the app (`sign-up`, `login`), `location` where on the page it was.
- **PostHog main project settings** the privacy policy relies on (they are project settings, not code): Authorized URLs
  include `https://code-review.com`; IP data capture is off for the organisation; Cookieless server hash mode is on;
  session recording retention is 30 days; the data processing agreement is accepted. Evaluate by filtering `site` or
  `$host`.

## Before launch

Manual steps outside the repository:

- [ ] Cloudflare: the steps above (production branch `main`, non-production branch builds off, root directory `website`,
      variables, build watch paths).
- [ ] PostHog main project: Authorized URLs include `https://code-review.com`; the settings listed above are true; after
      the first production deploy accept the banner on `https://code-review.com` and check that events arrive with
      `site = code-review` (`POST /ingest/e/` answers 200) and that a decline still counts a `$pageview`.
- [ ] `itegro-gmbh.de` lists `code-review.com` in its own `CROSS_DOMAINS` (other repository) for the way back.
- [ ] The app reads `ph_did` and `ph_sid` on `/sign-up` and `/login` (issue #692).
- [ ] The video after the first deploy: `curl -sI -H "Range: bytes=0-1" https://code-review.com/videos/code-review-demo-v3.mp4`
      answers `206` (Safari plays video only with range support), and the hero video plays with sound in Safari.
- [ ] Facts the privacy policy states, confirmed by the owner: the PostHog data processing agreement, the EU cloud
      (Frankfurt), the replay retention of 30 days (event retention cannot be configured per project, the policy names
      no period), Cloudflare's active entry in the Data Privacy Framework list, the email provider for
      `info@itegro-gmbh.de`, and the processors of the application (privacy policy sections 9 to 18).
- [ ] Lawyer review of the imprint, the privacy policy and the terms of service (the texts were drafted without one).
