// The conformance suite every IntegrationProvider implementation runs (the fake today, the GitHub
// App provider with its own ticket). It proves the contract of the interface: each method answers
// in normalized types only, never in a platform's raw format.
//
// Usage, in a *.test.ts file:
//   describeIntegrationProviderConformance("the fake provider", () => subject);
//
// `integrationProviderViolations` is the same check as plain data, so that the suite itself can be
// tested against a provider that breaks the contract.
import { describe, expect, it } from "vitest";
import {
  CONNECT_FLOW_KINDS,
  type IntegrationProvider,
} from "../integrations/provider.ts";
import {
  isGitAccess,
  isRepoRef,
  isReviewTrigger,
} from "../integrations/normalized.ts";
import {
  isIntegrationType,
  type Integration,
  type RepoRef,
  type ReviewTrigger,
} from "../integrations/types.ts";

export type ConformanceSubject = {
  provider: IntegrationProvider;
  integration: Integration;
  /** A repository the provider can hand out access for. */
  repo: RepoRef;
  /** A trigger the provider is asked to judge. */
  trigger: ReviewTrigger;
  /** A correctly signed delivery that means "a pull request was opened". */
  signedOpenedDelivery: () => Request;
  /** A delivery with a wrong signature. */
  badlySignedDelivery: () => Request;
  /** A correctly signed delivery that is of no interest for reviews. */
  irrelevantDelivery: () => Request;
  validConfig: unknown;
  invalidConfig: unknown;
};

export const CONFORMANCE_CHECKS = [
  "declares a known type and connect flow",
  "lists repositories as repo references of its integration",
  "answers whether a delivery is genuine with a boolean",
  "turns a delivery into a normalized review trigger",
  "returns null for a delivery that is not relevant",
  "answers whether a trigger may start a job with a boolean",
  "hands out job access as normalized git access",
  "reports one error per field for an invalid config",
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

/** Runs one check; returns what is wrong, or an empty list. */
export async function integrationProviderViolations(
  check: ConformanceCheck,
  subject: ConformanceSubject,
): Promise<string[]> {
  const { provider, integration } = subject;
  const problems: string[] = [];

  switch (check) {
    case "declares a known type and connect flow": {
      if (!isIntegrationType(provider.type))
        problems.push(
          `type "${String(provider.type)}" is not an IntegrationType`,
        );
      if (!CONNECT_FLOW_KINDS.some((kind) => kind === provider.connect.kind))
        problems.push(
          `connect flow "${String(provider.connect.kind)}" is unknown`,
        );
      break;
    }
    case "lists repositories as repo references of its integration": {
      const repos: unknown = await provider.listRepositories(integration);
      if (!Array.isArray(repos))
        return ["listRepositories did not return an array"];
      repos.forEach((repo, index) => {
        if (!isRepoRef(repo)) problems.push(`item ${index} is not a RepoRef`);
        else if (repo.integrationId !== integration.id)
          problems.push(`item ${index} belongs to another integration`);
      });
      break;
    }
    case "answers whether a delivery is genuine with a boolean": {
      const good: unknown = await provider.verifyWebhook(
        integration,
        subject.signedOpenedDelivery(),
      );
      const bad: unknown = await provider.verifyWebhook(
        integration,
        subject.badlySignedDelivery(),
      );
      if (good !== true)
        problems.push("a correctly signed delivery was not accepted");
      if (bad !== false)
        problems.push("a badly signed delivery was not refused with false");
      break;
    }
    case "turns a delivery into a normalized review trigger": {
      const request = subject.signedOpenedDelivery();
      const trigger: unknown = await provider.parseEvent(integration, request);
      if (!isReviewTrigger(trigger))
        problems.push("the result is not a ReviewTrigger");
      else if (trigger.repo.integrationId !== integration.id)
        problems.push("the trigger's repo belongs to another integration");
      break;
    }
    case "returns null for a delivery that is not relevant": {
      const trigger: unknown = await provider.parseEvent(
        integration,
        subject.irrelevantDelivery(),
      );
      if (trigger !== null)
        problems.push("an irrelevant delivery did not give null");
      break;
    }
    case "answers whether a trigger may start a job with a boolean": {
      const allowed: unknown = await provider.canTrigger(
        integration,
        subject.trigger,
      );
      if (typeof allowed !== "boolean")
        problems.push("canTrigger did not return a boolean");
      break;
    }
    case "hands out job access as normalized git access": {
      const access: unknown = await provider.jobAccess(
        integration,
        subject.repo,
      );
      if (!isGitAccess(access)) problems.push("the result is not a GitAccess");
      break;
    }
    case "reports one error per field for an invalid config": {
      const ok = provider.validateConfig(subject.validConfig);
      if (!ok.ok) problems.push("a valid config was refused");
      const bad = provider.validateConfig(subject.invalidConfig);
      if (bad.ok) return [...problems, "an invalid config was accepted"];
      const fields = bad.errors.map((error) => error.field);
      if (
        bad.errors.length === 0 ||
        fields.some((field) => typeof field !== "string")
      )
        problems.push("errors do not name a field each");
      if (new Set(fields).size !== fields.length)
        problems.push("a field is reported more than once");
      break;
    }
  }
  return problems;
}

export function describeIntegrationProviderConformance(
  name: string,
  createSubject: () => ConformanceSubject,
): void {
  describe(`${name} conforms to the integration provider interface`, () => {
    for (const check of CONFORMANCE_CHECKS) {
      it(check, async () => {
        expect(
          await integrationProviderViolations(check, createSubject()),
        ).toEqual([]);
      });
    }
  });
}
