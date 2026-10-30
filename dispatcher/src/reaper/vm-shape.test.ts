// SPDX-License-Identifier: LicenseRef-Proprietary

// The name a Launcher gives a job VM and the shape the stop route and the reaper recognise are one agreement (#759): a
// kind whose VM is not recognised could never be stopped or reaped, and would not count against its app's cap.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { KNOWN_KINDS } from "../core/types.ts";
import { jobVmName } from "../launchers/sandbox.ts";
import { findJobVms } from "../stop/job-stopper.ts";
import { shapeOf } from "./vm-shape.ts";

const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";

describe("the job VM of every kind", () => {
  // #759 (additional)
  it.each(KNOWN_KINDS)(
    "is recognised by the reaper's shape, with its tenant, when it is named like a %s launch names it",
    (kind) => {
      const name = jobVmName(kind, JOB, "abcd1234");

      expect(
        shapeOf({
          name,
          status: "running",
          createdAtMs: 0,
          tags: {
            app: "code-reviewer",
            kind,
            job: JOB,
            tenant: "factory",
          },
        }),
      ).toStrictEqual({ kind: "job", jobId: JOB, appId: "factory" });
    },
  );

  // #759 (additional)
  it.each(KNOWN_KINDS)(
    "is found by the stop route for its job and its app, and not for another app, as a %s VM",
    async (kind) => {
      const sandbox = new FakeSandboxService();
      const name = jobVmName(kind, JOB, "abcd1234");
      sandbox.seedVm({
        name,
        tags: { app: "code-reviewer", kind, job: JOB, tenant: "factory" },
        createdAtMs: Date.now() - 600_000,
      });

      expect(await findJobVms(sandbox, JOB, "factory")).toStrictEqual([name]);
      expect(await findJobVms(sandbox, JOB, "reviewer")).toStrictEqual([]);
    },
  );
});
