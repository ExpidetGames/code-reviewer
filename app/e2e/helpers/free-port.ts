// SPDX-License-Identifier: LicenseRef-Proprietary

// Ports for the fakes of the e2e lanes (#714, #585). The kernel hands the ports of its ephemeral range (Linux:
// 32768-60999 by default) to outgoing connections, so a fake that listens inside it can meet the connection of
// another process of the same job: `listen EADDRINUSE`, in the middle of a run, with no way to retry. A fake gets a
// port below that range instead, and the pick probes it: a short child process binds the port (and the ones after it,
// for a fake that takes several) on loopback, so a port that something listens on is never handed out.
// The pick is synchronous because the Playwright configuration needs the ports when it is loaded, before it can
// start anything; the choice is stored in the environment by the caller (e2e-env.ts) for the worker processes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The lowest start of an ephemeral range of the systems we run on (Linux 32768; macOS and Windows start higher). */
export const EPHEMERAL_FLOOR = 32768;

/** The range the kernel picks local ports of outgoing connections from; the Linux default when it cannot be read. */
export function ephemeralPortRange(): { low: number; high: number } {
  try {
    const [low, high] = readFileSync(
      "/proc/sys/net/ipv4/ip_local_port_range",
      "utf8",
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    if (Number.isInteger(low) && Number.isInteger(high) && low! > 0)
      return { low: Math.min(low!, EPHEMERAL_FLOOR), high: high! };
  } catch {
    // Not Linux: the default below.
  }
  return { low: EPHEMERAL_FLOOR, high: 60999 };
}

// Binds every port given on the command line on loopback; exits 1 when any is taken.
const PROBE = `
const net = require("node:net");
const ports = process.argv.slice(1).map(Number);
let pending = ports.length;
for (const port of ports) {
  const server = net.createServer();
  server.once("error", () => process.exit(1));
  server.listen(port, "127.0.0.1", () => {
    server.close(() => {
      pending -= 1;
      if (pending === 0) process.exit(0);
    });
  });
}
`;

function allFree(base: number, count: number): boolean {
  const ports = Array.from({ length: count }, (_, offset) =>
    String(base + offset),
  );
  const done = spawnSync(process.execPath, ["-e", PROBE, ...ports], {
    timeout: 10_000,
  });
  return done.status === 0;
}

export type PickOptions = {
  /** The first and the last port a pick may start at/reach; both inclusive and below the ephemeral range. */
  low: number;
  high: number;
  /** How many ports in a row the fake takes (the SMTP fake: three). */
  count?: number;
  /** Ports of this run that are already given out (also the ones after a group's first). */
  avoid?: ReadonlySet<number>;
  /** Only for the test of the probe itself. */
  allowEphemeral?: boolean;
};

/**
 * The first port of `count` consecutive ports in `low`…`high` that nothing listens on, none of them in `avoid`.
 * Throws when the range reaches into the ephemeral range, or when no free group is found.
 */
export function pickFreePort(options: PickOptions): number {
  const { low, high, count = 1, avoid = new Set<number>() } = options;
  const ephemeral = ephemeralPortRange();
  if (options.allowEphemeral !== true && high >= ephemeral.low)
    throw new Error(
      `The range ${String(low)}-${String(high)} reaches into the ephemeral range (${String(ephemeral.low)}-${String(ephemeral.high)}), whose ports the kernel gives to outgoing connections: a fake on one of them can find its port taken by a connection of the same run.`,
    );
  const starts = high - low + 2 - count;
  if (starts < 1)
    throw new Error(
      `No free port: the range ${String(low)}-${String(high)} is too small for ${String(count)} port(s).`,
    );
  const tried = new Set<number>();
  // Random starts, so that two checkouts on one machine rarely meet; a bounded number of probes, then a sweep over the rest.
  const budget = Math.min(starts, 40);
  while (tried.size < budget) {
    const base = low + Math.floor(Math.random() * starts);
    if (tried.has(base)) continue;
    tried.add(base);
    if (isFree(base, count, avoid)) return base;
  }
  for (let base = low; base < low + starts; base += 1) {
    if (tried.has(base)) continue;
    if (isFree(base, count, avoid)) return base;
  }
  throw new Error(
    `No free port in ${String(low)}-${String(high)} (${String(count)} in a row) that nothing listens on.`,
  );
}

function isFree(
  base: number,
  count: number,
  avoid: ReadonlySet<number>,
): boolean {
  for (let offset = 0; offset < count; offset += 1)
    if (avoid.has(base + offset)) return false;
  return allFree(base, count);
}
