// SPDX-License-Identifier: Apache-2.0

// The Dispatcher's own check of the shared contracts (contracts/README.md, "Who checks what"): the
// examples are valid under the schemas, and what the Dispatcher accepts and refuses agrees with them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DispatchWebhookSchema } from "./triggers/webhook-schema.ts";
import { parseSplitClaim } from "./core/app-client.ts";
import { readContract } from "./test-support/harness.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "contracts");

function ajvWithContracts(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of ["runner-api", "dispatch-webhook"])
    ajv.addSchema(readContract(`${file}.v1.json`) as object);
  return ajv;
}
const ajv = ajvWithContracts();

function validator(file: string, definition: string) {
  const check = ajv.getSchema(
    `https://github.com/ExpidetGames/code-reviewer/contracts/${file}.v1.json#/$defs/${definition}`,
  );
  if (check === undefined) throw new Error(`no definition ${definition}`);
  return check;
}

describe("the contracts the Dispatcher speaks", () => {
  // #327 (additional)
  it("has valid examples for the dispatch webhook, the split claim, the release and the version", () => {
    for (const [file, definition, example] of [
      [
        "dispatch-webhook",
        "DispatchWebhook",
        "examples/dispatch-webhook/DispatchWebhook.json",
      ],
      [
        "dispatch-webhook",
        "DispatchAccepted",
        "examples/dispatch-webhook/DispatchAccepted.json",
      ],
      [
        "dispatch-webhook",
        "DispatchIgnored",
        "examples/dispatch-webhook/DispatchIgnored.json",
      ],
      ["runner-api", "ClaimRequest", "examples/ClaimRequest.json"],
      ["runner-api", "SplitClaimResponse", "examples/SplitClaimResponse.json"],
      ["runner-api", "ReleaseRequest", "examples/ReleaseRequest.json"],
      ["runner-api", "ReleaseResponse", "examples/ReleaseResponse.json"],
      ["runner-api", "VersionResponse", "examples/VersionResponse.json"],
      ["runner-api", "JobStateResponse", "examples/JobStateResponse.json"],
    ] as const) {
      const check = validator(file, definition);
      expect(
        check(readContract(example)),
        `${definition}: ${JSON.stringify(check.errors)}`,
      ).toBe(true);
    }
    expect(
      readdirSync(join(CONTRACTS, "examples", "dispatch-webhook")).sort(),
    ).toStrictEqual([
      "DispatchAccepted.json",
      "DispatchIgnored.json",
      "DispatchWebhook.json",
    ]);
  });

  // #327-T02
  it("accepts and refuses the same webhook bodies as the schema file", () => {
    const good = readContract<Record<string, unknown>>(
      "examples/dispatch-webhook/DispatchWebhook.json",
    );
    const bodies: Array<[string, unknown]> = [
      ["the example", good],
      ["a second attempt", { ...good, attempt: 2 }],
      ["a dynamic job", { ...good, reviewKind: "dynamic" }],
      ["an unknown field", { ...good, extra: 1 }],
      ["a credential field", { ...good, credential: "crj_x" }],
      ["a missing field", { ...good, sentAt: undefined }],
      ["a wrong version", { ...good, version: 2 }],
      ["attempt zero", { ...good, attempt: 0 }],
      ["attempt 101", { ...good, attempt: 101 }],
      ["a fractional attempt", { ...good, attempt: 1.5 }],
      ["a bad job id", { ...good, jobId: "not-a-uuid" }],
      ["a bad timestamp", { ...good, sentAt: "yesterday" }],
      ["an unknown kind", { ...good, reviewKind: "other" }],
      ["an array", []],
      ["null", null],
    ];
    const check = validator("dispatch-webhook", "DispatchWebhook");

    for (const [name, body] of bodies)
      expect(DispatchWebhookSchema.safeParse(body).success, name).toBe(
        check(body),
      );
  });

  // #327 (additional)
  it("reads the split claim answer, and refuses the legacy one and a malformed credential", () => {
    const split = readContract<{ job: Record<string, unknown> }>(
      "examples/SplitClaimResponse.json",
    );
    const legacy = readContract("examples/ClaimResponse.json");

    expect(parseSplitClaim(split)).toMatchObject({ id: split.job.id });
    expect(parseSplitClaim(legacy)).toBeNull();
    expect(
      parseSplitClaim({ ...split, job: { ...split.job, credential: "short" } }),
    ).toBeNull();
    expect(parseSplitClaim({ ...split, version: 2 })).toBeNull();
    // The raw example file is read from disk too, so a change of the schema file shows here.
    expect(
      JSON.parse(
        readFileSync(
          join(CONTRACTS, "examples", "SplitClaimResponse.json"),
          "utf8",
        ),
      ),
    ).toBeTruthy();
  });
});
