// SPDX-License-Identifier: Apache-2.0

// #195-T10: the frozen neutral findings schema of Dynamic Review (contracts/dynamic-review) is version
// one, bounded, authority-free and validated against its examples. The same file is checked from the
// runner's side (runner/tests/contract), so both languages agree on the shape, the exact SHA field and
// the stable model-feature code. It must carry no provider, hosting-provider, routing, endpoint,
// command or permission field, its locations must be lexically safe, and it must be able to report a
// run that resolves every previous finding (zero current findings, resolutions on the envelope).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { RUNNER_ERROR_CODES } from "../../src/runner-api/contract.ts";
import { CONTRACTS_DIRECTORY } from "../../src/test-support/runner-contract.ts";

const DIRECTORY = join(CONTRACTS_DIRECTORY, "dynamic-review");
const schema = JSON.parse(
  readFileSync(join(DIRECTORY, "schema.v1.json"), "utf8"),
) as {
  $id: string;
  version: number;
  $defs: Record<string, { properties?: Record<string, unknown> }>;
};
const example = JSON.parse(
  readFileSync(join(DIRECTORY, "example.v1.json"), "utf8"),
) as Record<string, unknown>;
const resolvedOnly = JSON.parse(
  readFileSync(join(DIRECTORY, "example-resolved.v1.json"), "utf8"),
) as Record<string, unknown>;

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  strictRequired: false,
  allErrors: true,
});
ajv.addKeyword("version");
ajv.addSchema(schema);
const validate =
  ajv.getSchema(`${schema.$id}#/$defs/DynamicFindings`) ??
  (() => {
    throw new Error("The schema has no DynamicFindings definition.");
  })();

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
  const [first] = example.findings as Array<Record<string, unknown>>;
  return { ...first, ...overrides };
}

function documentWith(
  findings: Array<Record<string, unknown>>,
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...example, findings, ...envelope };
}

function propertyNames(node: unknown): Set<string> {
  if (Array.isArray(node)) {
    const names = new Set<string>();
    for (const entry of node)
      for (const name of propertyNames(entry)) names.add(name);
    return names;
  }
  if (typeof node !== "object" || node === null) return new Set();
  const record = node as Record<string, unknown>;
  const names = new Set<string>(
    Object.keys((record.properties as object) ?? {}),
  );
  for (const [key, value] of Object.entries(record))
    if (key !== "properties")
      for (const name of propertyNames(value)) names.add(name);
  return names;
}

describe("the Dynamic Review findings schema", () => {
  // #195-T10
  it("is version one, validates its examples and carries no provider-routing field", () => {
    expect(schema.version).toBe(1);
    expect(
      schema.$defs.DynamicFindings?.properties?.schemaVersion,
    ).toStrictEqual({ type: "integer", const: 1 });
    expect(validate(example)).toBe(true);
    // A run that resolves every previous finding has no current finding to carry the resolutions.
    expect(validate(resolvedOnly)).toBe(true);
    expect(resolvedOnly.findings).toStrictEqual([]);
    expect(resolvedOnly.resolvedIds).toStrictEqual(["f-1a2b3c"]);

    const names = propertyNames(schema);
    for (const forbidden of [
      "provider",
      "hostingProvider",
      "fallback",
      "endpoint",
      "command",
      "permission",
    ])
      expect(names.has(forbidden)).toBe(false);
  });

  // #195 finding 5: resolutions live on the envelope, not inside a current finding.
  it("accepts resolutions on the envelope and refuses them on a finding", () => {
    expect(validate(documentWith([finding({ resolvedIds: ["old"] })]))).toBe(
      false,
    );
    expect(
      validate(
        documentWith(example.findings as never, { resolvedIds: ["a", "b"] }),
      ),
    ).toBe(true);
    const withoutEnvelope = { ...resolvedOnly };
    delete withoutEnvelope.resolvedIds;
    expect(validate(withoutEnvelope)).toBe(false);
  });

  // #195 finding 6: lexical path safety is enforced by the schema.
  it.each([
    "../../outside.txt",
    "/etc/passwd",
    "C:\\secret",
    "src/../secret",
    "..",
    "a/..",
    "\\\\server\\share",
  ])("refuses the unsafe path %s", (path) => {
    expect(validate(documentWith([finding({ path })]))).toBe(false);
  });

  it("accepts ordinary repository-relative paths", () => {
    expect(
      validate(documentWith([finding({ path: "src/api/handler.ts" })])),
    ).toBe(true);
    expect(validate(documentWith([finding({ path: "./src/a.ts" })]))).toBe(
      true,
    );
  });

  // #195-T10
  it("lists the stable model-feature failure code", () => {
    expect([...RUNNER_ERROR_CODES]).toContain(
      "dynamic_model_features_unsupported",
    );
  });
});
