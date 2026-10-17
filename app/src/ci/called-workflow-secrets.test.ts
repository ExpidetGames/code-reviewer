// SPDX-License-Identifier: Apache-2.0

// Pins down how the Infisical sign-in reaches the reusable workflows of the production pipeline (#408). The four
// INFISICAL_* secrets are secrets of the environment `production`, which a called job selects with `environment:`.
// GitHub still hands a called workflow only the secrets its caller passes: a secret that is not passed resolves to an
// empty string, without an error ("Reuse workflows", environment secrets). The first deployment (run 39027505947)
// failed on exactly that. The caller passes the four by name and nothing else, so no other secret crosses over.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readText,
  readWorkflow,
  repoRoot,
  type Workflow,
} from "./workflow-support.ts";

const INFISICAL_SECRETS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_DOMAIN",
  "INFISICAL_PROJECT_SLUG",
];
const LOCAL_CALL = /^\.\/\.github\/workflows\/([\w.-]+\.yml)$/;

type Call = { caller: string; job: string; callee: string; secrets: unknown };

const files = readdirSync(`${repoRoot}.github/workflows`).filter((name) =>
  name.endsWith(".yml"),
);

/** Every job that calls a workflow of this repository. */
function localCalls(): Call[] {
  return files.flatMap((caller) =>
    Object.entries(readWorkflow(caller).jobs).flatMap(([job, found]) => {
      const callee = LOCAL_CALL.exec(found.uses ?? "")?.[1];
      return callee ? [{ caller, job, callee, secrets: found.secrets }] : [];
    }),
  );
}

const readsInfisical = (callee: string): boolean =>
  /secrets\.INFISICAL_/.test(readText(`.github/workflows/${callee}`));

describe("secrets of the called workflows", () => {
  const calls = localCalls().filter((call) => readsInfisical(call.callee));

  // #408-T01
  it("finds the calls of the pipeline that need the Infisical sign-in", () => {
    expect(calls.map((call) => `${call.caller}:${call.job}`).sort()).toEqual([
      "deploy-production.yml:canary",
      "deploy-production.yml:snapshot-build",
      "deploy-production.yml:stage-app",
      "deploy-production.yml:stage-dispatcher",
    ]);
  });

  // #408-T01
  it("passes exactly the four Infisical secrets by name at every such call, never everything", () => {
    for (const call of calls) {
      const label = `${call.caller}:${call.job}`;
      expect(call.secrets, label).not.toBe("inherit");
      expect(call.secrets, label).toEqual(
        Object.fromEntries(
          INFISICAL_SECRETS.map((name) => [name, `\${{ secrets.${name} }}`]),
        ),
      );
    }
  });

  // #408-T02
  it("declares those four as required secrets of the called workflow, and nothing else", () => {
    for (const callee of new Set(calls.map((call) => call.callee))) {
      const declared = (
        readWorkflow(callee).on.workflow_call as Workflow["on"] & {
          secrets?: Record<string, { required?: boolean }>;
        }
      ).secrets;
      expect(Object.keys(declared ?? {}).sort(), callee).toEqual(
        INFISICAL_SECRETS,
      );
      for (const name of INFISICAL_SECRETS)
        expect(declared?.[name]?.required, `${callee} ${name}`).toBe(true);
    }
  });

  // #408-T03
  it("keeps the rollback workflow free of calls, or passes the secrets the same way", () => {
    const rollback = localCalls().filter(
      (call) => call.caller === "rollback-production.yml",
    );
    expect(rollback.filter((call) => readsInfisical(call.callee))).toEqual([]);
  });

  // #408-T01
  it("lets no job that calls a workflow take an environment (GitHub rejects it)", () => {
    for (const caller of files)
      for (const [job, found] of Object.entries(readWorkflow(caller).jobs))
        if (found.uses?.startsWith("./"))
          expect(found.environment, `${caller}:${job}`).toBeUndefined();
  });
});
