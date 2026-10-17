// SPDX-License-Identifier: Apache-2.0

// Pins down the composite action that loads the CI secrets from Infisical
// (.github/actions/infisical-ci-secrets/action.yml, #403): production only, so the Infisical environment is
// always `prod` and the path always `/ci`; the sign-in settings are checked first, every secret is read by a call
// of its own and masked, and every loaded value is checked to be non-empty without printing it. It reads the file
// as YAML; that Infisical accepts the calls is verified by the first real run (docs/deployment-vercel.md).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readText, type CompositeAction } from "./workflow-support.ts";

const source = readText(".github/actions/infisical-ci-secrets/action.yml");
const action = parse(source) as CompositeAction;
const steps = action.runs.steps;
const loads = steps.filter((step) =>
  step.uses?.startsWith("Infisical/secrets-action@"),
);

describe("the Infisical secrets action", () => {
  // #403-T04
  it("is a composite action that pins the Infisical action to the v1.0.18 commit", () => {
    expect(action.runs.using).toBe("composite");
    expect(loads.length).toBeGreaterThanOrEqual(6);
    for (const load of loads)
      expect(load.uses).toBe(
        "Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d",
      );
  });

  // #403-T06
  it("always reads /ci of the environment prod, with Universal Auth, into the job environment", () => {
    for (const load of loads) {
      expect(load.with?.method).toBe("universal");
      expect(load.with?.["secret-path"]).toBe("/ci");
      expect(load.with?.["env-slug"]).toBe("prod");
      expect(load.with?.["export-type"]).toBe("env");
    }
    // Production only: there is nothing to choose.
    expect(Object.keys(action.inputs ?? {})).not.toContain("environment");
    expect(Object.keys(action.inputs ?? {})).not.toContain("secret-path");
    expect(action.outputs?.["env-slug"]).toBeUndefined();
  });

  // #403-T06
  it("reads exactly one secret per call, so a job never receives more of /ci than it names", () => {
    const names = loads.map((load) => String(load.with?.["secret-name"]));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names)
      expect(name).toMatch(/^\$\{\{ steps\.config\.outputs\.name_[1-9] \}\}$/);
    // The first call is unconditional, every other one only runs for a name that was given.
    expect(loads[0]?.if).toBeUndefined();
    for (const load of loads.slice(1)) expect(load.if).toMatch(/name_\d != ''/);
  });

  // #403-T06
  it("takes the four sign-in values as inputs, because a composite action cannot read secrets", () => {
    expect(Object.keys(action.inputs ?? {}).sort()).toEqual(
      [
        "client-id",
        "client-secret",
        "consequence",
        "domain",
        "project-slug",
        "secret-names",
      ].sort(),
    );
    for (const load of loads) {
      expect(load.with?.["client-id"]).toBe("${{ inputs.client-id }}");
      expect(load.with?.["client-secret"]).toBe("${{ inputs.client-secret }}");
      expect(load.with?.domain).toBe("${{ inputs.domain }}");
      expect(load.with?.["project-slug"]).toBe("${{ inputs.project-slug }}");
    }
    expect(source).not.toMatch(/\$\{\{\s*(secrets|vars)\./);
  });

  // #403-T06
  it("checks the settings and the secret names first, and names what is missing without printing a value", () => {
    const check = steps[0];
    expect(check?.id).toBe("config");
    const run = check?.run ?? "";
    for (const name of [
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_DOMAIN",
      "INFISICAL_PROJECT_SLUG",
    ])
      expect(run).toContain(`[ -n "\${${name}}" ]`);
    expect(run).toContain("^[A-Z][A-Z0-9_]*$");
    expect(run).toMatch(/\$\{#names\[@\]\} -gt 6|-gt 6/);
    // The values come in as environment variables, never as shell text.
    expect(run).not.toContain("${{");
    expect(run).not.toMatch(/echo[^\n]*\$\{?INFISICAL_CLIENT/);
  });

  // #403-T06
  it("ends with a check that every loaded value is non-empty, by indirect expansion and without printing it", () => {
    const last = steps[steps.length - 1];
    expect(last?.name).toBe("Check the loaded values");
    expect(last?.run).toContain('[ -n "${!name:-}" ]');
    expect(last?.run).not.toMatch(/echo[^\n]*\$\{!name/);
    expect(last?.run).not.toContain("${{");
  });

  // #403-T06
  it("does not ignore a failure of any step", () => {
    for (const step of steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
