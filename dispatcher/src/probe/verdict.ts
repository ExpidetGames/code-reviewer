// SPDX-License-Identifier: Apache-2.0

// What the Worker image's `probe` mode prints (contracts/probe-verdict.v1.json, runner/README.md) and how the
// Dispatcher reads it. The output comes from a container that runs next to hostile pull request content, so it
// is data, not an instruction: the Dispatcher reads one line, takes from it only the engines it knows and the
// reasons of the contract's closed list, and drops everything else without ever echoing it. `opencode` counts as
// proven only from a verdict that says it and gives no reason against it (fail closed).
import { z } from "zod";
import type { Engine } from "../core/types.ts";

/** The `SelfCheckReason` values of the runner: the closed list of `ProbeReason` in the contract (a test holds them equal). */
export const PROBE_REASONS = [
  "not_a_dynamic_runner",
  "not_root_supervisor",
  "engine_user_invalid",
  "network_rules_not_installed",
  "capabilities_not_dropped",
  "root_filesystem_writable",
  "ipv6_not_disabled",
  "pin_unreadable",
  "pin_untrusted",
  "engine_binary_missing",
  "engine_binary_untrusted",
  "engine_binary_checksum_mismatch",
  "engine_version_mismatch",
  "ripgrep_missing",
  "ripgrep_untrusted",
  "ripgrep_checksum_mismatch",
  "network_probe_failed",
] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

const KNOWN_ENGINES: readonly Engine[] = ["pr-agent", "opencode"];
/** A verdict is one short line; more than this is not from our probe. */
const MAX_OUTPUT_BYTES = 64 * 1024;

const LineSchema = z.object({
  version: z.literal(1),
  engines: z.array(z.unknown()).max(16),
  reasons: z.array(z.unknown()).max(64),
});

/** What the Dispatcher keeps of a verdict. Holds engines and stable reasons only. */
export type ParsedVerdict = {
  /** The engines the container may advertise; `opencode` only when it `passed`. */
  engines: Engine[];
  reasons: ProbeReason[];
  /** True when `opencode` is advertised and nothing was said against it. */
  passed: boolean;
};

function isEngine(value: unknown): value is Engine {
  return (KNOWN_ENGINES as readonly unknown[]).includes(value);
}

function isReason(value: unknown): value is ProbeReason {
  return (PROBE_REASONS as readonly unknown[]).includes(value);
}

/** The verdict in the stdout of a probe run, or undefined when there is none to read. Never throws. */
export function parseProbeOutput(stdout: string): ParsedVerdict | undefined {
  if (stdout.length > MAX_OUTPUT_BYTES) return undefined;
  const last = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .at(-1);
  if (last === undefined) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(last);
  } catch {
    return undefined;
  }
  const line = LineSchema.safeParse(document);
  if (!line.success) return undefined;

  const stated = line.data.engines.filter(isEngine);
  const reasons = [...new Set(line.data.reasons.filter(isReason))];
  const droppedReason = reasons.length < new Set(line.data.reasons).size;
  const claimsOpencode = stated.includes("opencode");
  // A verdict that advertises opencode and in the same breath gives a reason against it, or has a reason
  // this reader does not know, is not a pass.
  const passed = claimsOpencode && reasons.length === 0 && !droppedReason;
  const engines = [...new Set(stated)].filter(
    (engine) => engine !== "opencode" || passed,
  );
  return { engines, reasons, passed };
}
