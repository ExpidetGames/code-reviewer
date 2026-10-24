// SPDX-License-Identifier: LicenseRef-Proprietary

// The address of the first-run setup page and the request header with which the setup gate
// (src/setup/gate-proxy.ts) marks a page request that has to be served from it. `next.config.ts`
// rewrites a marked request to the setup page, so the proxy builds no address: an address would carry
// the protocol and host Next.js made of the request (a client's `X-Forwarded-Proto` included), and
// Next.js treats a rewrite to any other origin than its own as a request to forward to that server,
// which fails (500). The same failure and the same fix as the admin portal's rewrite (#146, #155).

/** The page that shows the setup in place of the page that was asked for. */
export const SETUP_PAGE = "/setup";

/**
 * The request header with which the proxy marks a page request that `next.config.ts` serves from the
 * setup page. Only the proxy may set it: it takes the header off every request it sees that arrives
 * with it from outside (src/auth/access-proxy.ts), so a client that sends it is served nothing. The
 * setup page behind the rewrite checks the setup state again itself (src/app/setup/page.tsx), so the
 * header grants nothing even to a request that reached the rewrite some other way.
 */
export const SETUP_REWRITE_HEADER = "x-setup-rewrite";
