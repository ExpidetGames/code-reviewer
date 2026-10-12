// SPDX-License-Identifier: Apache-2.0

// The runner API contract (contracts/runner-api.v1.json) as validators, for tests that check a real
// answer or request against the file. The file is read from disk, not copied: it is the one source.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

export const CONTRACTS_DIRECTORY = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "contracts",
);

export type ContractSchema = {
  $id: string;
  version: number;
  $defs: Record<string, { enum?: string[] } & Record<string, unknown>>;
};

export function readContract(): ContractSchema {
  return JSON.parse(
    readFileSync(join(CONTRACTS_DIRECTORY, "runner-api.v1.json"), "utf8"),
  ) as ContractSchema;
}

export type ContractValidator = {
  /** The verdict for a document and, if it was refused, why (for the failure message). */
  check(
    definition: string,
    document: unknown,
  ): { valid: boolean; errors: string };
};

export function createContractValidator(): ContractValidator {
  const schema = readContract();
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  // `version` is documentation of the file itself, not a validation keyword.
  ajv.addKeyword("version");
  ajv.addSchema(schema);
  return {
    check(definition, document) {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
      if (validate === undefined)
        throw new Error(`The contract has no definition ${definition}.`);
      const valid = validate(document) === true;
      return {
        valid,
        errors: valid ? "" : ajv.errorsText(validate.errors),
      };
    },
  };
}

/** The examples of the contract: definition name and document. */
export function readExamples(): Array<{
  definition: string;
  document: unknown;
}> {
  const directory = join(CONTRACTS_DIRECTORY, "examples");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      definition: name.replace(/\.json$/, ""),
      document: JSON.parse(
        readFileSync(join(directory, name), "utf8"),
      ) as unknown,
    }));
}
