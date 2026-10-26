// SPDX-License-Identifier: LicenseRef-Proprietary

// The per-launcher additions of the Sandbox variant of the hardened container spec
// (contracts/worker-container.v1.json, #316, #325): the two IPv6 switches are not part of the spec itself,
// and they are the ones the runner's IPv6 proof and the docs ask for. The Sandbox-Launcher renders the spec
// to `docker run` flags (dispatcher/src/launchers/container.ts, whose own test pins the spec it ships to the
// same example).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const spec = JSON.parse(
  read("contracts/examples/worker-container/WorkerContainerSpec.json"),
) as Record<string, unknown>;

describe("the per-launcher additions of the Sandbox variant", () => {
  const additions = JSON.parse(
    read(
      "contracts/examples/worker-container/WorkerContainerLauncherAdditions.json",
    ),
  ) as { sysctls: Record<string, string> };

  // #325-T08
  it("are not in the spec: they belong to the Sandbox variant only", () => {
    expect(spec).not.toHaveProperty("sysctls");
  });

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
