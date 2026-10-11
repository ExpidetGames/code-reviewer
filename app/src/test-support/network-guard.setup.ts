// SPDX-License-Identifier: Apache-2.0

// Vitest setup file, loaded for every test file of the unit and integration projects.
// It makes any TCP connection to a host other than loopback fail with NETWORK_GUARD_BLOCKED,
// so no automated test can reach the internet (fetch, http, https and tls all end in
// net.Socket#connect). Extra hosts, such as compose service names, can be allowed with the
// comma separated TEST_ALLOWED_HOSTS variable.
import net from "node:net";

export const NETWORK_GUARD_BLOCKED = "NETWORK_GUARD_BLOCKED" as const;

const allowedExtraHosts = new Set(
  (process.env.TEST_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

export function isAllowedHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowedExtraHosts.has(normalized)) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return true;
  if (normalized === "::1" || normalized === "::ffff:127.0.0.1") return true;
  return /^127(\.\d{1,3}){3}$/.test(normalized);
}

type ConnectTarget = { host: string } | { socketPath: string };

// net.Socket#connect accepts (options), (path) and (port[, host]); with no host it means
// localhost. Node's own net.connect passes the already normalized form [options, callback].
function resolveTarget(args: unknown[]): ConnectTarget {
  const [first, second] = Array.isArray(args[0])
    ? (args[0] as unknown[])
    : args;
  if (first !== null && typeof first === "object") {
    const options = first as { host?: string; path?: string };
    if (options.path) return { socketPath: options.path };
    return { host: options.host ?? "localhost" };
  }
  // A numeric string is a port (Node accepts it); only other strings are unix socket paths.
  if (typeof first === "string" && Number.isNaN(Number(first)))
    return { socketPath: first };
  return { host: typeof second === "string" ? second : "localhost" };
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(
  this: net.Socket,
  ...args: unknown[]
) {
  const target = resolveTarget(args);
  if ("host" in target && !isAllowedHost(target.host)) {
    const error = Object.assign(
      new Error(
        `Network access to "${target.host}" is blocked in automated tests. Use a fake server on loopback.`,
      ),
      { code: NETWORK_GUARD_BLOCKED },
    );
    // Fail like a real connection error (asynchronously, through the socket) so HTTP clients
    // reject their request instead of hanging on a synchronous throw inside their connector.
    process.nextTick(() => this.destroy(error));
    return this;
  }
  // The overloads of connect cannot be forwarded with a plain spread in TypeScript.
  return (originalConnect as (...forwarded: unknown[]) => net.Socket).apply(
    this,
    args,
  );
} as typeof net.Socket.prototype.connect;
