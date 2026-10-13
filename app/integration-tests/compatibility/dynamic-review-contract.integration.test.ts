// SPDX-License-Identifier: Apache-2.0

// #195-T10: the frozen neutral findings schema of Dynamic Review (contracts/dynamic-review) is version
// one, bounded, authority-free and validated against its example. The same file is checked from the
// runner's side (runner/tests/contract), so both languages agree on the shape, the exact SHA field and
// the stable model-feature code. It must carry no provider, hosting-provider, routing, endpoint,
// command or permission field.
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
) as unknown;

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
  it("is version one, validates its example and carries no provider-routing field", () => {
    const ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictRequired: false,
      allErrors: true,
    });
    ajv.addKeyword("version");
    ajv.addSchema(schema);

    expect(schema.version).toBe(1);
    expect(
      schema.$defs.DynamicFindings?.properties?.schemaVersion,
    ).toStrictEqual({ const: 1 });
    const validate = ajv.compile({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: `${schema.$id}#/$defs/DynamicFindings`,
    });
    expect(validate(example)).toBe(true);

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

  // #195-T10
  it("lists the stable model-feature failure code", () => {
    expect([...RUNNER_ERROR_CODES]).toContain(
      "dynamic_model_features_unsupported",
    );
  });
});
