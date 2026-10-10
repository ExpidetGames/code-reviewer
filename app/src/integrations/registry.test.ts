// Pins down how a stored integration type is turned into its provider, and that every way of not
// finding one ends in a stable error code.
import { describe, expect, it } from "vitest";
import { fakeIntegrationProvider } from "../test-support/fake-integration-provider.ts";
import { IntegrationError } from "./errors.ts";
import { createIntegrationRegistry, integrationRegistry } from "./registry.ts";

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof IntegrationError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the integration registry", () => {
  it("resolves a registered type to its provider", () => {
    const provider = fakeIntegrationProvider();
    const registry = createIntegrationRegistry({ github_app: provider });

    expect(registry.resolve("github_app")).toBe(provider);
  });

  // CR-20-T03
  it("fails with a stable code for a type it has never heard of", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(errorCodeOf(() => registry.resolve("gitlab"))).toBe(
      "INTEGRATION_TYPE_UNKNOWN",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a reserved type that has no provider yet", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(errorCodeOf(() => registry.resolve("bitbucket_cloud"))).toBe(
      "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a known type nobody registered", () => {
    const registry = createIntegrationRegistry({});

    expect(errorCodeOf(() => registry.resolve("github_app"))).toBe(
      "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
    );
  });

  // CR-20-T03
  it("fails with a stable code for a value that is not even a string", () => {
    const registry = createIntegrationRegistry({});

    expect(errorCodeOf(() => registry.resolve(undefined))).toBe(
      "INTEGRATION_TYPE_UNKNOWN",
    );
  });

  it("refuses a provider registered under a type it does not implement", () => {
    const provider = {
      ...fakeIntegrationProvider(),
      type: "github_app" as const,
    };
    const wrongKey = { github_app: { ...provider, type: "other" } } as never;

    expect(() => createIntegrationRegistry(wrongKey)).toThrow(/other/);
  });

  it("lists the types that have a provider", () => {
    const registry = createIntegrationRegistry({
      github_app: fakeIntegrationProvider(),
    });

    expect(registry.registeredTypes()).toEqual(["github_app"]);
  });
});

describe("the application's integration registry", () => {
  it("is the one place that wires the providers of the app", () => {
    expect(integrationRegistry.registeredTypes()).toEqual([]);
  });
});
