// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the network guard of the privileged Dynamic e2e lane (#253): the counters of the nft rules in
// e2e/dynamic/guard.nft. A violation counter above zero means a process of the lane (OpenCode, Git, a helper,
// anything) tried to reach something that is not on loopback, which is where the fakes are; a test that reads
// them fails then. The control counters are the lane's own attempts to a reserved address, which prove that
// the counters move for each kind of process. Needs root (`nft`), so only the lane can read it.
import { spawnSync } from "node:child_process";

export const GUARD_TABLE = "cr_lane_guard";
export const GUARD_CHAIN = "output";
/** The reserved documentation range the controls connect to (TEST-NET-1): nothing real is ever there. */
export const CONTROL_PREFIX = {
  ipv4: "192.0.2.0/24",
  host: "192.0.2.1",
} as const;

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

/** The sets of e2e/dynamic/guard-trace.nft. */
export const TRACE_SETS = ["seen4", "seen6"] as const;

function destinationText(address: string, protocol: string, port: number) {
  const host = address.includes(":") ? `[${address}]` : address;
  return `${host}:${String(port)}/${protocol}`;
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
    if (
      Array.isArray(concat) &&
      concat.length === 3 &&
      typeof concat[0] === "string" &&
      typeof concat[1] === "string" &&
      typeof concat[2] === "number"
    ) {
      found.push(destinationText(concat[0], concat[1], concat[2]));
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return found;
}

/**
 * Where the rejected packets went (root only). A lane without the trace file, or a listing that cannot be read, has none:
 * the numbers of the counters are the verdict, the destinations only explain it.
 */
export function readGuardDestinations(): string[] {
  return TRACE_SETS.flatMap((set) => {
    const done = spawnSync(
      "nft",
      ["-j", "list", "set", "inet", GUARD_TABLE, set],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (done.status !== 0) return [];
    try {
      return parseDestinations(JSON.parse(done.stdout));
    } catch {
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
}
