// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the network guard of the privileged Dynamic e2e lane (#253): the counters of the nft rules in
// e2e/dynamic/guard.nft. A violation counter above zero means a process of the lane (OpenCode, Git, a helper,
// anything) tried to reach something that is not on loopback, which is where the fakes are; a test that reads
// them fails then. The control counters are the lane's own attempts to a reserved address, which prove that
// the counters move for each kind of process. Needs root (`nft`), so only the lane can read it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const GUARD_TABLE = "cr_lane_guard";
export const GUARD_CHAIN = "output";
/** The reserved documentation range the controls connect to (TEST-NET-1): nothing real is ever there. */
export const CONTROL_PREFIX = {
  ipv4: "192.0.2.0/24",
  host: "192.0.2.1",
} as const;

/** The questions the lane's resolver was asked (one `TYPE name` per line), written by lane-dns-stub-command.ts. */
export const LANE_DNS_LOG = "/run/lane-dns.log";
/** The names the lane's programs may ask for (#714). Relative to the working directory (app/), not import.meta: Playwright loads this file as CommonJS. */
export const DNS_ALLOWLIST_FILE = resolve(
  process.cwd(),
  "e2e/dynamic/dns-allowlist.txt",
);

export type GuardWho = "engine" | "job" | "root" | "other";
export type ControlWho = "engine" | "job" | "root";
const VIOLATIONS: readonly GuardWho[] = ["engine", "job", "root", "other"];
const CONTROLS: readonly ControlWho[] = ["engine", "job", "root"];

/** Packets counted so far. */
export type GuardReading = {
  violations: Record<GuardWho, number>;
  controls: Record<ControlWho, number>;
};

const WHO_TEXT: Record<GuardWho, string> = {
  engine: "the engine user (the pinned OpenCode, or anything it started)",
  job: "the Diff job user",
  root: "root (the runner, Git, the fakes, a helper process)",
  other: "another user",
};

type NftRule = {
  comment?: unknown;
  expr?: Array<{ counter?: { packets?: unknown } }>;
};

function counterOf(rules: NftRule[], comment: string): number {
  const found = rules.find((item) => item.comment === comment);
  const packets = found?.expr?.find((item) => item.counter !== undefined)
    ?.counter?.packets;
  if (typeof packets !== "number")
    throw new Error(
      `The network guard has no counter "${comment}": its rules are not the ones of e2e/dynamic/guard.nft, so nothing is guarded.`,
    );
  return packets;
}

/** Reads the output of `nft -j list chain inet cr_lane_guard output`. */
export function parseGuard(json: unknown): GuardReading {
  const items =
    typeof json === "object" && json !== null && "nftables" in json
      ? (json as { nftables: unknown }).nftables
      : undefined;
  const rules = (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
    const rule = (item as { rule?: NftRule } | null)?.rule;
    return rule === undefined ? [] : [rule];
  });
  const read = (prefix: string, who: readonly string[]) =>
    Object.fromEntries(
      who.map((name) => [name, counterOf(rules, `${prefix}-${name}`)]),
    );
  if (!Array.isArray(items))
    throw new Error("The output of nft is not a ruleset listing.");
  return {
    violations: read("violation", VIOLATIONS) as GuardReading["violations"],
    controls: read("control", CONTROLS) as GuardReading["controls"],
  };
}

/** One sentence per kind of user that tried to reach something that is not loopback. */
export function describeAttempts(reading: GuardReading): string[] {
  return VIOLATIONS.filter((who) => reading.violations[who] > 0).map(
    (who) =>
      `${WHO_TEXT[who]} tried ${String(reading.violations[who])} time(s) to connect to something that is not on loopback`,
  );
}

/**
 * Fails (throws) when anything of the lane reached for the network. `destinations` (from `readGuardDestinations`) are
 * named when there are any: where the connections went is what a failure is fixed from.
 */
export function assertNoExternalAttempts(
  reading: GuardReading,
  destinations: readonly string[] = [],
): void {
  const attempts = describeAttempts(reading);
  if (attempts.length === 0) return;
  const where =
    destinations.length === 0
      ? ""
      : ` Destinations seen: ${destinations.join(", ")}.`;
  throw new Error(
    `The network guard saw connections that no fake answers: ${attempts.join("; ")}.${where}`,
  );
}

/** Name lookups on loopback, where the lane's own resolver answers: they never reach the violation counters. */
export type DnsReading = {
  queries: Record<GuardWho, number>;
  /** The engine user's query to 127.0.0.2:53 (the control that proves `queries.engine` counts for the engine user). */
  controlEngine: number;
};

/** Reads the dns-* counters from the output of `nft -j list chain inet cr_lane_guard output`. */
export function parseDns(json: unknown): DnsReading {
  const items =
    typeof json === "object" && json !== null && "nftables" in json
      ? (json as { nftables: unknown }).nftables
      : undefined;
  if (!Array.isArray(items))
    throw new Error("The output of nft is not a ruleset listing.");
  const rules = items.flatMap((item: unknown) => {
    const rule = (item as { rule?: NftRule } | null)?.rule;
    return rule === undefined ? [] : [rule];
  });
  return {
    queries: Object.fromEntries(
      VIOLATIONS.map((who) => [who, counterOf(rules, `dns-${who}`)]),
    ) as DnsReading["queries"],
    controlEngine: counterOf(rules, "dns-control-engine"),
  };
}

/** The names of an allowlist file: one per line, `#` starts a comment. */
export function parseDnsAllowlist(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim().toLowerCase())
      .filter((line) => line !== ""),
  );
}

/** The names in the resolver's log (`A github.com` → `github.com`), lower case, without the root dot. */
export function parseAskedNames(log: string): string[] {
  return log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) =>
      line
        .slice(line.indexOf(" ") + 1)
        .toLowerCase()
        .replace(/\.$/, ""),
    );
}

/**
 * What is wrong with the name lookups of the lane: the engine user asked for any name at all, or a name is not on the
 * allowlist. The engine user needs no name (its model and the fakes are addresses), so one query of it is a violation even
 * when the name is allowed for the other programs.
 */
export function describeDnsProblems(
  reading: DnsReading,
  askedNames: readonly string[],
  allowed: ReadonlySet<string>,
  destinations: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  if (reading.queries.engine > 0)
    problems.push(
      `the engine user (the pinned OpenCode, or anything it started) sent ${String(reading.queries.engine)} DNS query packet(s) to the lane's resolver; the engine user may not look up any name${destinations.length === 0 ? "" : ` (lookups on loopback, by user: ${destinations.join(", ")})`}`,
    );
  const unlisted = [
    ...new Set(askedNames.filter((name) => !allowed.has(name))),
  ];
  if (unlisted.length > 0)
    problems.push(
      `names asked of the lane's resolver that are not on e2e/dynamic/dns-allowlist.txt: ${unlisted.join(", ")}`,
    );
  return problems;
}

/** Fails (throws) when {@link describeDnsProblems} finds anything. */
export function assertDnsQuiet(
  reading: DnsReading,
  askedNames: readonly string[],
  allowed: ReadonlySet<string>,
  destinations: readonly string[] = [],
): void {
  const problems = describeDnsProblems(
    reading,
    askedNames,
    allowed,
    destinations,
  );
  if (problems.length > 0)
    throw new Error(
      `The network guard saw name lookups: ${problems.join("; ")}.`,
    );
}

/** The names asked so far and the allowlist, from the files of the lane. */
export function readAskedNames(logFile = LANE_DNS_LOG): string[] {
  return parseAskedNames(readFileSync(logFile, "utf8"));
}

export function readDnsAllowlist(file = DNS_ALLOWLIST_FILE): Set<string> {
  return parseDnsAllowlist(readFileSync(file, "utf8"));
}

/** The sets of e2e/dynamic/guard-trace.nft. */
export const TRACE_SETS = ["seen4", "seen6"] as const;
export const DNS_TRACE_SETS = ["dns4", "dns6"] as const;

const PROTOCOL_NAMES: Record<number, string> = { 6: "tcp", 17: "udp" };

function destinationText(address: string, protocol: string, port: number) {
  const host = address.includes(":") ? `[${address}]` : address;
  return `${host}:${String(port)}/${protocol}`;
}

/** nft prints the protocol of an `inet_proto` element by name when it knows it (`udp`) and as a number when it does not. */
function protocolText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return PROTOCOL_NAMES[value] ?? String(value);
  return null;
}

function portNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The destinations in the output of `nft -j list set`: every address, protocol and port element of the listing. */
export function parseDestinations(json: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const concat = (node as { concat?: unknown }).concat;
    if (Array.isArray(concat) && concat.length === 3) {
      const protocol = protocolText(concat[1]);
      const port = portNumber(concat[2]);
      if (typeof concat[0] === "string" && protocol !== null && port !== null) {
        found.push(destinationText(concat[0], protocol, port));
        return;
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return found;
}

/** The elements `user address protocol port` of the DNS sets: `uid 10101 → 127.0.0.1:53/udp`. */
export function parseDnsDestinations(json: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const concat = (node as { concat?: unknown }).concat;
    if (Array.isArray(concat) && concat.length === 4) {
      const protocol = protocolText(concat[2]);
      const port = portNumber(concat[3]);
      const user = concat[0];
      if (
        (typeof user === "string" || typeof user === "number") &&
        typeof concat[1] === "string" &&
        protocol !== null &&
        port !== null
      ) {
        found.push(
          `${typeof user === "number" ? "uid " : ""}${String(user)} → ${destinationText(concat[1], protocol, port)}`,
        );
        return;
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return found;
}

/**
 * Where the rejected packets went (root only). A lane without the trace file, or a listing that cannot be read, has none:
 * the numbers of the counters are the verdict, the destinations only explain it; that they are missing is said on stderr.
 */
export function readGuardDestinations(): string[] {
  return readSets(TRACE_SETS, parseDestinations);
}

/** Who sent name lookups on loopback, and to which address and port (the dns4 and dns6 sets of guard-trace.nft). */
export function readDnsDestinations(): string[] {
  return readSets(DNS_TRACE_SETS, parseDnsDestinations);
}

function readSets(
  sets: readonly string[],
  parse: (json: unknown) => string[],
): string[] {
  return sets.flatMap((set) => {
    const done = spawnSync(
      "nft",
      ["-j", "list", "set", "inet", GUARD_TABLE, set],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (done.status !== 0) {
      process.stderr.write(
        `destinations unreadable: nft list set ${set} failed (${done.error?.message ?? done.stderr.trim()})\n`,
      );
      return [];
    }
    try {
      const destinations = parse(JSON.parse(done.stdout));
      if (destinations.length === 0 && /"elem"\s*:\s*\[/.test(done.stdout))
        process.stderr.write(
          `destinations unreadable: the listing of ${set} has elements, none of them an address, protocol and port\n`,
        );
      return destinations;
    } catch (error) {
      process.stderr.write(
        `destinations unreadable: the listing of ${set} is not JSON (${error instanceof Error ? error.message : String(error)})\n`,
      );
      return [];
    }
  });
}

/** Reads the counters of the kernel now (root only). */
export function readGuard(): GuardReading {
  const done = spawnSync(
    "nft",
    ["-j", "list", "chain", "inet", GUARD_TABLE, GUARD_CHAIN],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (done.status !== 0)
    throw new Error(
      `The network guard cannot be read (nft: ${done.error?.message ?? done.stderr.trim()}). It must be loaded by runner/scripts/run_dynamic_e2e.sh and read as root.`,
    );
  return parseGuard(JSON.parse(done.stdout));
}

/** Reads the DNS counters of the kernel now (root only). */
export function readDns(): DnsReading {
  const done = spawnSync(
    "nft",
    ["-j", "list", "chain", "inet", GUARD_TABLE, GUARD_CHAIN],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (done.status !== 0)
    throw new Error(
      `The network guard cannot be read (nft: ${done.error?.message ?? done.stderr.trim()}).`,
    );
  return parseDns(JSON.parse(done.stdout));
}

/** The engine user of the Worker image: its processes must not outlive the Worker. */
const ENGINE_UID = 10101;

/** The processes of the engine user, `pid command` per line. */
export function engineProcesses(): string[] {
  const done = spawnSync("ps", ["-u", String(ENGINE_UID), "-o", "pid=,args="], {
    encoding: "utf8",
  });
  // ps exits 1 when no process matches.
  return done.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Reads the guard now and fails when anything of the lane reached for the network, naming where it went. */
export function assertGuardQuiet(): void {
  const reading = readGuard();
  assertNoExternalAttempts(
    reading,
    describeAttempts(reading).length === 0 ? [] : readGuardDestinations(),
  );
  const dns = readDns();
  assertDnsQuiet(
    dns,
    readAskedNames(),
    readDnsAllowlist(),
    dns.queries.engine > 0 ? readDnsDestinations() : [],
  );
}
