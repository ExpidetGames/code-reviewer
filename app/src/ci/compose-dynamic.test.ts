// SPDX-License-Identifier: Apache-2.0

// Pins down compose.dynamic.yml as a file (#202): the opt-in second runner for Dynamic Review. It is
// an override file like compose.build.yml, so nothing in compose.yml, compose.coolify.yml or
// compose.large.yml changes and a default installation never starts it. It adds one service with
// one Dynamic slot, a memory limit that fits it, a hardened container and no secret. Whether the
// engine really runs in it is the image smoke test and the engine suite (#197), not a file test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Service = {
  image?: string;
  restart?: string;
  ports?: string[];
  profiles?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  mem_limit?: string;
  mem_reservation?: string;
  memswap_limit?: string;
  pids_limit?: number | string;
  cap_drop?: string[];
  cap_add?: string[];
  privileged?: boolean;
  security_opt?: string[];
  stop_grace_period?: string;
  entrypoint?: unknown;
  command?: unknown;
};
type Compose = { services: Record<string, Service> };

const source = read("compose.dynamic.yml");
const dynamic = parse(source) as Compose;
const plain = parse(read("compose.yml")) as Compose;

function runnerDynamic(): Service {
  const found = dynamic.services["runner-dynamic"];
  if (!found)
    throw new Error('compose.dynamic.yml has no service "runner-dynamic"');
  return found;
}

/** The number of bytes of a Docker memory value such as `2g` or `1536m`. */
function bytes(value: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(value);
  if (!match) throw new Error(`not a memory value: ${value}`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g"
  ];
  return Number(match[1]) * unit;
}

/** The default of `${NAME:-default}`. */
function defaultOf(reference: string | undefined): string {
  const match = /^\$\{[A-Z0-9_]+:-([^}]*)\}$/.exec(reference ?? "");
  if (!match) throw new Error(`no default in ${reference}`);
  return match[1] ?? "";
}

describe("compose.dynamic.yml", () => {
  // #202-T08
  it("adds exactly one service, the Dynamic runner, and changes none of the existing ones", () => {
    expect(Object.keys(dynamic.services)).toEqual(["runner-dynamic"]);
    expect(plain.services).not.toHaveProperty("runner-dynamic");
  });

  // #202-T08
  it("is opt-in: a file of its own, not a profile that a stray flag could switch on", () => {
    expect(runnerDynamic()).not.toHaveProperty("profiles");
    expect(read("compose.yml")).not.toContain("runner-dynamic");
    expect(read("compose.coolify.yml")).not.toContain("runner-dynamic");
    expect(read("compose.large.yml")).not.toContain("runner-dynamic");
  });

  // #202-T08
  it("takes its image from a variable of its own, because the Dynamic image differs from the Diff one", () => {
    expect(runnerDynamic().image).toMatch(
      /^\$\{RUNNER_DYNAMIC_IMAGE:-ghcr\.io\/expidetgames\/code-reviewer-runner:development\}$/,
    );
  });

  // #202-T05
  it("runs one Dynamic job at a time by default", () => {
    const environment = runnerDynamic().environment ?? {};

    expect(defaultOf(environment.RUNNER_CONCURRENCY)).toBe("1");
    expect(environment.RUNNER_CONCURRENCY).toContain(
      "RUNNER_DYNAMIC_CONCURRENCY",
    );
  });

  // #202-T10
  it("gives each Dynamic slot at least 1 GiB plus a reserve for the runner, and no swap", () => {
    const service = runnerDynamic();
    const limit = bytes(defaultOf(service.mem_limit));

    // The spike's conservative proposal: 1 GiB per Dynamic slot plus the runner and proxy reserve.
    expect(limit).toBeGreaterThanOrEqual(2 * 1024 ** 3);
    expect(bytes(defaultOf(service.mem_reservation))).toBeGreaterThanOrEqual(
      1.5 * 1024 ** 3,
    );
    expect(bytes(defaultOf(service.mem_reservation))).toBeLessThan(limit);
    // Swap would hide the cgroup peak the OOM matrix is meant to measure.
    expect(service.memswap_limit).toBe(service.mem_limit);
  });

  // #202-T08
  it("hardens the container: no capability, no privilege escalation, a bounded number of processes", () => {
    const service = runnerDynamic();

    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service).not.toHaveProperty("cap_add");
    expect(service.privileged).not.toBe(true);
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(Number(service.pids_limit)).toBeGreaterThan(0);
    expect(Number(service.pids_limit)).toBeLessThanOrEqual(1024);
  });

  // #202-T08
  it("is wired like the runner: no port, the app over the Docker network, the same stop grace", () => {
    const service = runnerDynamic();
    const runner = plain.services.runner;

    expect(service).not.toHaveProperty("ports");
    expect(service.depends_on?.app?.condition).toBe("service_healthy");
    expect(service.environment?.RUNNER_API_URL).toBe("http://app:3000");
    expect(service.environment?.RUNNER_TOKEN).toBe(
      runner?.environment?.RUNNER_TOKEN,
    );
    expect(service.restart).toBe("unless-stopped");
    expect(service.stop_grace_period).toBe(runner?.stop_grace_period);
    expect(service).not.toHaveProperty("entrypoint");
    expect(service).not.toHaveProperty("command");
  });

  // #202-T08
  it("does not advertise the engine: it passes only the operator's model descriptor, empty by default", () => {
    const environment = runnerDynamic().environment ?? {};

    expect(environment.RUNNER_DYNAMIC_CAPABILITIES).toBe(
      "${RUNNER_DYNAMIC_CAPABILITIES:-}",
    );
    // The checkout and the node directory belong to the per-job preparation, not to deployment.
    expect(Object.keys(environment)).not.toContain("RUNNER_DYNAMIC_CHECKOUT");
    expect(Object.keys(environment)).not.toContain("RUNNER_DYNAMIC_NODE_BIN");
  });

  // #202-T08
  it("writes no secret into the file, only a reference to the runner token", () => {
    const environment = runnerDynamic().environment ?? {};

    for (const [key, value] of Object.entries(environment)) {
      if (!/SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD/.test(key)) continue;
      expect(String(value), key).toMatch(/^\$\{[A-Z0-9_]+:\?[^}]*\}$/);
    }
    expect(source).not.toContain("PR_AGENT_COMMAND");
  });

  // #202-T08
  it("says in its first lines that Dynamic Review cannot be activated with it yet", () => {
    const header = source.split("\n").slice(0, 12).join("\n");

    expect(header).toMatch(/not (yet )?activatable|cannot be activated/i);
    expect(header).toContain("docs/dynamic-review.md");
  });
});
