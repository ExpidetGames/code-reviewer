// SPDX-License-Identifier: LicenseRef-Proprietary

// The capability set of the running server, read from the environment (`PRODUCT_ID`, `PRODUCT_CAPABILITIES`). The server
// refuses to start with a wrong setting (src/deploy/startup.ts); a read that finds one anyway (the dev server, a test)
// throws instead of guessing, because a wrong guess would show or hide a feature by accident.
import "server-only";
import type { CapabilitySet } from "./capability.ts";
import { resolveCapabilityConfig, type ProductId } from "./products.ts";

export class CapabilityConfigError extends Error {
  readonly safeMessage = true as const;
  constructor(problems: readonly string[]) {
    super(`CAPABILITIES_INVALID: ${problems.join("; ")}.`);
    this.name = "CapabilityConfigError";
  }
}

export type DeploymentCapabilities = {
  product: ProductId;
  capabilities: CapabilitySet;
};

let cached: { key: string; value: DeploymentCapabilities } | undefined;

/** The product and the capabilities of this deployment. Read again only when the environment changed (tests do). */
export function getDeploymentCapabilities(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentCapabilities {
  const key = `${env.PRODUCT_ID ?? ""}|${env.PRODUCT_CAPABILITIES ?? ""}`;
  if (cached?.key === key) return cached.value;
  const config = resolveCapabilityConfig(env);
  if (!config.ok) throw new CapabilityConfigError(config.problems);
  const value = { product: config.product, capabilities: config.capabilities };
  cached = { key, value };
  return value;
}

export function getCapabilities(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CapabilitySet {
  return getDeploymentCapabilities(env).capabilities;
}
