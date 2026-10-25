// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOverrides, assertHardenedSpec } from "./container.ts";
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";

function example(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/examples/worker-container/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

describe("the spec the launcher ships", () => {
  // #325-T02
  it("equals the example spec of the contract, which equals both compose files", () => {
    expect(WORKER_CONTAINER_SPEC).toEqual(example("WorkerContainerSpec"));
  });

  // #325-T02
  it("is hardened", () => {
    expect(() => assertHardenedSpec(WORKER_CONTAINER_SPEC)).not.toThrow();
  });

  // #325-T05
  it("accepts the example overrides of the contract", () => {
    const overrides = example("WorkerContainerOverrides");

    expect(
      applyOverrides(WORKER_CONTAINER_SPEC, overrides as never).memory,
    ).toEqual({ limit: "1536m", reservation: "1280m", swap: "1536m" });
  });

  // #325-T08
  it("ships the Sandbox additions of the contract: the two IPv6 switches, nothing more", () => {
    expect(SANDBOX_LAUNCHER_ADDITIONS).toEqual(
      example("WorkerContainerLauncherAdditions"),
    );
    // The shared spec itself has no sysctl: the self-hosted compose files carry none.
    expect(WORKER_CONTAINER_SPEC).not.toHaveProperty("sysctls");
  });
});
