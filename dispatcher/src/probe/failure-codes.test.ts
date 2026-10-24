// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { readContract } from "../test-support/harness.ts";
import { CREATE_FAILURES } from "../launchers/sandbox.ts";
import { PROBE_FAILURE_CODES, probeFailureCode } from "./failure-codes.ts";

describe("the closed list of probe failure codes", () => {
  // #331-R04
  it("is the list of the contract's ProbeReport.failure", () => {
    const contract = readContract<{
      $defs: { ProbeFailure: { enum: string[] } };
    }>("probe-verdict.v1.json");

    expect([...PROBE_FAILURE_CODES].sort()).toStrictEqual(
      [...contract.$defs.ProbeFailure.enum].sort(),
    );
  });

  // #331-R04
  it("holds every code of a refused create and of the host preparation", () => {
    for (const { code } of Object.values(CREATE_FAILURES))
      expect(PROBE_FAILURE_CODES).toContain(code);
    for (const code of [
      "sandbox_create_failed",
      "sandbox_config_invalid",
      "docker_not_ready",
      "vm_prepare_failed",
      "image_missing",
      "image_mismatch",
      "probe_timeout",
      "probe_unreadable",
      "probe_error",
      "probe_exit_nonzero",
      "probe_exec_failed",
      "probe_aborted",
      "probe_not_supported",
    ])
      expect(PROBE_FAILURE_CODES).toContain(code);
  });

  // #331-R04
  it("keeps a listed code and turns anything else into probe_error", () => {
    expect(probeFailureCode("sandbox_unavailable")).toBe("sandbox_unavailable");
    expect(probeFailureCode("a1b2c3d4e5f6a1b2c3d4")).toBe("probe_error");
    expect(probeFailureCode("some_new_platform_code")).toBe("probe_error");
    expect(probeFailureCode(undefined)).toBe("probe_error");
    expect(probeFailureCode(42)).toBe("probe_error");
    expect(probeFailureCode("PROBE_TIMEOUT")).toBe("probe_error");
  });
});
