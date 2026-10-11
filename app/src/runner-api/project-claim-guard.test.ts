// Pins down the claim guard of the projects: an active project lets the job run, anything else cancels it.
import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import { createProjectClaimGuard } from "./project-claim-guard.ts";

const job = {
  id: "job-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
} as Job;

describe("the project claim guard", () => {
  // CR-46-T01
  it("allows a job whose repository has an active project", async () => {
    const asked: string[] = [];
    const guard = createProjectClaimGuard({
      projects: () => ({
        getActiveProjectForRepository: async (repositoryId) => {
          asked.push(repositoryId);
          return {} as never;
        },
      }),
    });

    expect(await guard.check(job)).toStrictEqual({ allow: true });
    expect(asked).toStrictEqual(["repo-1"]);
  });

  // CR-46-T01
  it("cancels a job whose repository has no active project", async () => {
    const guard = createProjectClaimGuard({
      projects: () => ({
        getActiveProjectForRepository: async () => undefined,
      }),
    });

    expect(await guard.check(job)).toStrictEqual({
      allow: false,
      errorCode: "project_deactivated",
      outcome: "cancel",
    });
  });
});
