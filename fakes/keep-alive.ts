// SPDX-License-Identifier: LicenseRef-Proprietary

// The HTTP fakes are called directly by tests (Playwright's `request`, a fetch in a journey) that reuse connections between
// steps pausing longer than the five seconds after which Node closes an idle connection (its default `keepAliveTimeout`).
// A request sent at the moment the fake closes its end fails with `read ECONNRESET` (#714). Test-only code: every fake keeps idle
// connections far longer than any pause of a test, and `headersTimeout` stays above it (Node requires that).
import type { Server } from "node:http";

export const FAKE_KEEP_ALIVE_TIMEOUT_MS = 120_000;
export const FAKE_HEADERS_TIMEOUT_MS = FAKE_KEEP_ALIVE_TIMEOUT_MS + 5_000;

/** Makes `server` keep idle connections open for {@link FAKE_KEEP_ALIVE_TIMEOUT_MS}; returns it. */
export function keepConnectionsOpen<T extends Server>(server: T): T {
  server.keepAliveTimeout = FAKE_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = FAKE_HEADERS_TIMEOUT_MS;
  return server;
}
