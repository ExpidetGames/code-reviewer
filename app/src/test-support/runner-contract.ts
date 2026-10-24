// SPDX-License-Identifier: LicenseRef-Proprietary

// The contracts (contracts/runner-api.v1.json by default, contracts/operator-api.v1.json, worker-api, dispatch-webhook, worker-container) as validators, for tests that check a real
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

export const RUNNER_CONTRACT_FILE = "runner-api.v1.json";
export const OPERATOR_CONTRACT_FILE = "operator-api.v1.json";

export function readContract(file = RUNNER_CONTRACT_FILE): ContractSchema {
  return JSON.parse(
    readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8"),
  ) as ContractSchema;
}

export type ContractValidator = {
  /** The verdict for a document and, if it was refused, why (for the failure message). */
  check(
    definition: string,
    document: unknown,
  ): { valid: boolean; errors: string };
};

export function createContractValidator(
  file = RUNNER_CONTRACT_FILE,
): ContractValidator {
  const schema = readContract(file);
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  // `version` is documentation of the file itself, not a validation keyword.
  ajv.addKeyword("version");
  ajv.addSchema(schema);
  // The contract files of the hosted deployment (#318) refer to each other by relative reference
  // (the Worker API reuses RunnerJobInput), so every sibling is known to the validator.
  for (const name of readdirSync(CONTRACTS_DIRECTORY)) {
    if (!name.endsWith(".v1.json") || name === file) continue;
    const sibling = readContract(name);
    // A data file (the model lists) has no `$id` and nothing refers to it; two of them would collide under no key.
    if ((sibling as { $id?: string }).$id === undefined) continue;
    if (sibling.$id !== schema.$id) ajv.addSchema(sibling);
  }
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
export function readExamples(folder = "examples"): Array<{
  definition: string;
  document: unknown;
}> {
  const directory = join(CONTRACTS_DIRECTORY, folder);
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
