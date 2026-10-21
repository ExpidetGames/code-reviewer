// SPDX-License-Identifier: Apache-2.0

// The fake Stripe API never touches a network: it listens on, and delivers webhooks to, the loopback of this machine only.

/** `localhost` (with or without the final dot), `127.0.0.0/8` and `::1`, as the URL parser spells a host. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return (
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Whether a URL (an endpoint of the app) points at the loopback of this machine. False for anything that does not parse. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}
