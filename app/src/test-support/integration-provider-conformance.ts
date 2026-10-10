// The conformance suite every IntegrationProvider implementation runs (the fake today, the GitHub
// App provider with its own ticket). It proves the contract of the interface: each method answers
// in normalized types only, never in a platform's raw format, and the request body stays readable.
//
// Usage, in a *.test.ts file:
//   describeIntegrationProviderConformance("the fake provider", () => subject);
//
// `integrationProviderViolations` is the same check as plain data, so that the suite itself can be
// tested against a provider that breaks the contract.
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../integrations/errors.ts";
import {
  isGitAccess,
  isIntegrationEvent,
  isPullRequestRef,
  isRepoRef,
} from "../integrations/normalized.ts";
import {
  CONNECT_FLOW_KINDS,
  type IntegrationProvider,
} from "../integrations/provider.ts";
import {
  isIntegrationType,
  type Integration,
  type RepoRef,
  type ReviewTrigger,
} from "../integrations/types.ts";

export type ConformanceSubject = {
  provider: IntegrationProvider;
  integration: Integration;
  /** A repository the provider can hand out access for and knows pull requests of. */
  repo: RepoRef;
  /** A trigger the provider is asked to judge. */
  trigger: ReviewTrigger;
  /** A correctly signed delivery that means "a pull request was opened" (a new Request per call). */
  signedOpenedDelivery: () => Request;
  /** A delivery signed with a wrong secret. */
  badlySignedDelivery: () => Request;
  /** A delivery whose body was changed after it was signed. */
  tamperedDelivery: () => Request;
  /** A correctly signed delivery that is of no interest for reviews. */
  irrelevantDelivery: () => Request;
  /** A correctly signed delivery that says the connection was removed. */
  installationRemovedDelivery: () => Request;
  /** A pull request number that exists in `repo`, and one that does not. */
  existingPullRequestNumber: number;
  missingPullRequestNumber: number;
  validConfig: unknown;
  invalidConfig: unknown;
};

export const CONFORMANCE_CHECKS = [
  "declares a known type and connect flow",
  "lists repositories as repo references of its integration",
  "refuses a delivery with a wrong or tampered signature and accepts a genuine one",
  "identifies the connection of a delivery",
  "keeps the request body readable after verifying, identifying and parsing",
  "turns a delivery into a normalized review trigger",
  "reports a removed connection as an installation change",
  "reports a delivery that is not relevant as ignored",
  "answers whether a trigger may start a job with a boolean",
  "hands out job access as normalized git access with a hidden token",
  "returns pull requests as normalized pull request references",
  "reports an unknown pull request with a stable error code",
  "reports one error per field for an invalid config",
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

/** Runs one check; returns what is wrong, or an empty list. */
export async function integrationProviderViolations(
  check: ConformanceCheck,
  subject: ConformanceSubject,
): Promise<string[]> {
  const { provider, integration, repo } = subject;
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
      repos.forEach((item, index) => {
        if (!isRepoRef(item)) problems.push(`item ${index} is not a RepoRef`);
        else if (item.integrationId !== integration.id)
          problems.push(`item ${index} belongs to another integration`);
      });
      break;
    }
    case "refuses a delivery with a wrong or tampered signature and accepts a genuine one": {
      const verify = async (
        integrationOrNull: Integration | null,
        request: Request,
      ): Promise<unknown> => provider.verifyWebhook(integrationOrNull, request);
      if ((await verify(integration, subject.signedOpenedDelivery())) !== true)
        problems.push("a correctly signed delivery was not accepted");
      if ((await verify(null, subject.signedOpenedDelivery())) !== true)
        problems.push(
          "a correctly signed delivery was not accepted without an integration",
        );
      if ((await verify(null, subject.badlySignedDelivery())) !== false)
        problems.push("a badly signed delivery was not refused with false");
      if ((await verify(null, subject.tamperedDelivery())) !== false)
        problems.push("a delivery with a tampered body was not refused");
      break;
    }
    case "identifies the connection of a delivery": {
      const identity: unknown = await provider.identifyWebhook(
        subject.signedOpenedDelivery(),
      );
      if (identity === null) break;
      const externalId = (identity as { externalId?: unknown } | undefined)
        ?.externalId;
      if (typeof externalId !== "string" || externalId === "")
        problems.push("the identity is neither null nor { externalId }");
      else if (externalId !== integration.externalId)
        problems.push("the identified connection is not the integration's");
      break;
    }
    case "keeps the request body readable after verifying, identifying and parsing": {
      const request = subject.signedOpenedDelivery();
      await provider.verifyWebhook(null, request);
      await provider.identifyWebhook(request);
      await provider.parseEvent(integration, request);
      if (request.bodyUsed)
        problems.push("the request body was consumed, not read from a clone");
      else if ((await request.text()) === "")
        problems.push("the request body is empty afterwards");
      break;
    }
    case "turns a delivery into a normalized review trigger": {
      const event: unknown = await provider.parseEvent(
        integration,
        subject.signedOpenedDelivery(),
      );
      if (!isIntegrationEvent(event))
        problems.push("the result is not an IntegrationEvent");
      else if (event.kind !== "review_trigger")
        problems.push(`an opened delivery gave "${event.kind}"`);
      else if (event.trigger.repo.integrationId !== integration.id)
        problems.push("the trigger's repo belongs to another integration");
      break;
    }
    case "reports a removed connection as an installation change": {
      const event: unknown = await provider.parseEvent(
        integration,
        subject.installationRemovedDelivery(),
      );
      if (!isIntegrationEvent(event))
        problems.push("the result is not an IntegrationEvent");
      else if (
        event.kind !== "installation_changed" ||
        event.action !== "deleted" ||
        event.externalId !== integration.externalId
      )
        problems.push("the removal was not reported as a deleted installation");
      break;
    }
    case "reports a delivery that is not relevant as ignored": {
      const event: unknown = await provider.parseEvent(
        integration,
        subject.irrelevantDelivery(),
      );
      if (!isIntegrationEvent(event))
        problems.push("the result is not an IntegrationEvent");
      else if (event.kind !== "ignored")
        problems.push(`an irrelevant delivery gave "${event.kind}"`);
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
    case "hands out job access as normalized git access with a hidden token": {
      const access: unknown = await provider.jobAccess(integration, repo);
      if (!isGitAccess(access))
        problems.push(
          "the result is not a GitAccess (or its token is visible when serialized)",
        );
      break;
    }
    case "returns pull requests as normalized pull request references": {
      const one: unknown = await provider.getPullRequest(
        integration,
        repo,
        subject.existingPullRequestNumber,
      );
      if (!isPullRequestRef(one))
        problems.push("getPullRequest did not return a PullRequestRef");
      const open: unknown = await provider.listOpenPullRequests(
        integration,
        repo,
      );
      if (!Array.isArray(open))
        return [...problems, "listOpenPullRequests did not return an array"];
      open.forEach((item, index) => {
        if (!isPullRequestRef(item))
          problems.push(`open pull request ${index} is not a PullRequestRef`);
        else if (item.state !== "open")
          problems.push(`open pull request ${index} is not open`);
      });
      break;
    }
    case "reports an unknown pull request with a stable error code": {
      const failure = await provider
        .getPullRequest(integration, repo, subject.missingPullRequestNumber)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      if (
        !(failure instanceof IntegrationError) ||
        failure.code !== "INTEGRATION_PULL_REQUEST_NOT_FOUND"
      )
        problems.push(
          "a missing pull request did not fail with INTEGRATION_PULL_REQUEST_NOT_FOUND",
        );
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
