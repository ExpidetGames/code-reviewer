// SPDX-License-Identifier: Apache-2.0

// The hardened container spec (contracts/worker-container.v1.json, #316, #325) and the two compose
// services that run the same container on a self-hosted installation must stay one definition. The
// example WorkerContainerSpec is the spec; compose.dynamic.yml and the runner-dynamic service of
// compose.coolify.yml are translated into the same shape and must equal it. The Sandbox-Launcher
// renders the spec to `docker run` flags (dispatcher/src/launchers/container.ts, whose own test
// pins the spec it ships to the same example), so a flag that changes in a compose file, or in the
// spec, fails here until the others follow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  differences,
  specFromComposeService,
  type ComposeService,
} from "./worker-container-parity.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const spec = JSON.parse(
  read("contracts/examples/worker-container/WorkerContainerSpec.json"),
) as Record<string, unknown>;

const COMPOSE_FILES = ["compose.dynamic.yml", "compose.coolify.yml"] as const;

function serviceOf(path: string, text = read(path)): ComposeService {
  const compose = parse(text) as { services: Record<string, ComposeService> };
  const service = compose.services["runner-dynamic"];
  if (service === undefined) throw new Error(`${path} has no runner-dynamic`);
  return service;
}

// Names the legacy loop needs and a Worker container never gets from its launcher: where the app
// is, the dispatcher credential, and how the loop polls and how many jobs it takes at once. The
// Worker reads the app address and its per-job credential from stdin.
const LOOP_ONLY_ENVIRONMENT = [
  "RUNNER_API_URL",
  "RUNNER_CONCURRENCY",
  "RUNNER_POLL_INTERVAL_SECONDS",
  "RUNNER_TOKEN",
];

describe("the hardened container spec against the compose files", () => {
  // #325-T02
  it.each(COMPOSE_FILES)(
    "is equal to the runner-dynamic service of %s",
    (path) => {
      expect(
        differences(spec, specFromComposeService(serviceOf(path))),
      ).toEqual([]);
    },
  );

  // #325-T02
  it.each(COMPOSE_FILES)(
    "lists in %s exactly the loop-only environment names beside the allowed ones",
    (path) => {
      const names = Object.keys(serviceOf(path).environment ?? {}).sort();
      const allowed = spec.allowedEnvironment as string[];

      expect(names).toEqual([...allowed, ...LOOP_ONLY_ENVIRONMENT].sort());
    },
  );

  // #325-T02
  it("keeps the self-hosted memory defaults of the compose files equal in both", () => {
    const [first, second] = COMPOSE_FILES.map((path) =>
      specFromComposeService(serviceOf(path)),
    );

    expect(first?.memory).toEqual(second?.memory);
    expect(first?.memory).toEqual(spec.memory);
  });
});

describe("the per-launcher additions of the Sandbox variant", () => {
  const additions = JSON.parse(
    read(
      "contracts/examples/worker-container/WorkerContainerLauncherAdditions.json",
    ),
  ) as { sysctls: Record<string, string> };

  // #325-T08
  it.each(COMPOSE_FILES)(
    "are not in %s: a full-mode host keeps its behaviour",
    (path) => {
      const service = serviceOf(path);

      expect(service).not.toHaveProperty("sysctls");
      expect(spec).not.toHaveProperty("sysctls");
    },
  );

  // #325-T08
  it("are the two switches the runner's IPv6 proof and the docs ask the container spec for", () => {
    const docs = read("docs/dynamic-review.md");
    const proof = read(
      "runner/src/code_reviewer_runner/dynamic_review/ipv6_off.py",
    );

    expect(Object.keys(additions.sysctls).sort()).toEqual([
      "net.ipv6.conf.all.disable_ipv6",
      "net.ipv6.conf.default.disable_ipv6",
    ]);
    for (const [name, value] of Object.entries(additions.sysctls)) {
      expect(value).toBe("1");
      expect(docs).toContain(`${name}=1`);
    }
    // The proof reads `disable_ipv6` of `all` and `default` and wants both to be 1.
    expect(proof).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    expect(proof).toContain("disable_ipv6");
  });
});

describe("a changed flag is found", () => {
  // Each change is applied to the text of a compose file, as a person editing it would.
  const CHANGES: Array<[string, (text: string) => string]> = [
    [
      "a smaller pids limit",
      (t) => t.replace("pids_limit: 512", "pids_limit: 4096"),
    ],
    [
      "a writable root",
      (t) => t.replace("read_only: true", "read_only: false"),
    ],
    ["another user", (t) => t.replace('user: "0:0"', 'user: "10001:10001"')],
    [
      "a dropped no-new-privileges",
      (t) => t.replace("- no-new-privileges:true", "- seccomp=unconfined"),
    ],
    [
      "another capability",
      (t) => t.replace("      - FOWNER", "      - SYS_ADMIN"),
    ],
    [
      "a tmpfs that may run a program",
      (t) => t.replace("/tmp:rw,noexec,", "/tmp:rw,"),
    ],
    ["a larger tmpfs", (t) => t.replace("size=1m,", "size=64m,")],
    [
      "another stop timeout",
      (t) => t.replace("stop_grace_period: 90s", "stop_grace_period: 30s"),
    ],
    [
      "another memory default",
      (t) => t.replace("MEMORY_LIMIT:-2g}", "MEMORY_LIMIT:-4g}"),
    ],
    [
      "privileged",
      (t) =>
        t.replace(
          "    read_only: true",
          "    privileged: true\n    read_only: true",
        ),
    ],
    [
      "a volume",
      (t) =>
        t.replace(
          "    read_only: true",
          "    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n    read_only: true",
        ),
    ],
    [
      "host networking",
      (t) =>
        t.replace(
          "    read_only: true",
          "    network_mode: host\n    read_only: true",
        ),
    ],
    [
      "a device",
      (t) =>
        t.replace(
          "    read_only: true",
          "    devices:\n      - /dev/kvm\n    read_only: true",
        ),
    ],
    [
      "a sysctl",
      (t) =>
        t.replace(
          "    read_only: true",
          "    sysctls:\n      net.ipv4.ip_forward: 1\n    read_only: true",
        ),
    ],
  ];

  // #325-T02
  it.each(
    COMPOSE_FILES.flatMap((path) =>
      CHANGES.map((change) => [path, ...change] as const),
    ),
  )("in %s: %s", (path, _name, change) => {
    const text = read(path);
    // Only the runner-dynamic service: the other services carry flags of their own.
    const start = text.indexOf("\n  runner-dynamic:\n");
    const changed = text.slice(0, start) + change(text.slice(start));
    // The change must have touched the file, or the case proves nothing.
    expect(changed).not.toBe(text);

    expect(
      differences(spec, specFromComposeService(serviceOf(path, changed))),
    ).not.toEqual([]);
  });

  // #325-T02
  it("in the spec: a changed capability, tmpfs or limit", () => {
    const service = specFromComposeService(serviceOf("compose.dynamic.yml"));
    const changed = { ...spec, pids: { limit: 256 } };

    expect(differences(changed, service)).not.toEqual([]);
    expect(
      differences(
        { ...spec, capAdd: (spec.capAdd as unknown[]).slice(1) },
        service,
      ),
    ).not.toEqual([]);
  });
});
