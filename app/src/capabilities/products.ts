// SPDX-License-Identifier: LicenseRef-Proprietary

// The products this codebase is deployed as, and which capabilities each may have (#731). `PRODUCT_CAPABILITIES`
// can only narrow `allowed`; unset, a product gets its `default`, so the deployment that exists today (code-review.com)
// needs no new setting. The `allowed` list is the code wall: `implementer` is in none of them yet, so no setting can
// make a deployment of these products start the Software Factory.
import {
  CAPABILITIES,
  createCapabilitySet,
  isCapability,
  requiredCapability,
  type Capability,
  type CapabilitySet,
} from "./capability.ts";

export const PRODUCT_IDS = ["code-review-com", "factory"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export const DEFAULT_PRODUCT_ID: ProductId = "code-review-com";

type ProductDefinition = {
  allowed: readonly Capability[];
  default: readonly Capability[];
};

export const PRODUCTS: Readonly<Record<ProductId, ProductDefinition>> = {
  "code-review-com": {
    allowed: ["review", "dynamic-review", "billing"],
    default: ["review", "dynamic-review", "billing"],
  },
  factory: {
    allowed: ["review", "dynamic-review", "billing"],
    default: ["review", "dynamic-review"],
  },
};

export const PRODUCT_ENV = "PRODUCT_ID";
export const CAPABILITIES_ENV = "PRODUCT_CAPABILITIES";

type Env = Readonly<Record<string, string | undefined>>;

export type CapabilityConfig =
  | { ok: true; product: ProductId; capabilities: CapabilitySet }
  | { ok: false; problems: string[] };

function isProductId(value: string): value is ProductId {
  return (PRODUCT_IDS as readonly string[]).includes(value);
}

/**
 * The product and capability set the environment asks for, or what is wrong with it. The problems name the
 * variables and, for a capability that exists but is not allowed here, its name; a value that is not a known name is
 * never repeated (a variable that holds something else must not end up in a log).
 */
export function resolveCapabilityConfig(env: Env): CapabilityConfig {
  const problems: string[] = [];
  const productValue = env[PRODUCT_ENV]?.trim() ?? "";
  let product = DEFAULT_PRODUCT_ID;
  if (productValue !== "") {
    if (isProductId(productValue)) product = productValue;
    else
      problems.push(
        `${PRODUCT_ENV} is not a product of this codebase (known: ${PRODUCT_IDS.join(", ")})`,
      );
  }
  const definition = PRODUCTS[product];

  const listValue = env[CAPABILITIES_ENV]?.trim() ?? "";
  if (listValue === "") {
    return problems.length > 0
      ? { ok: false, problems }
      : {
          ok: true,
          product,
          capabilities: createCapabilitySet(definition.default),
        };
  }

  const chosen = new Set<Capability>();
  for (const raw of listValue.split(",")) {
    const name = raw.trim();
    if (!isCapability(name)) {
      problems.push(
        `${CAPABILITIES_ENV} names a capability that does not exist (known: ${CAPABILITIES.join(", ")})`,
      );
      continue;
    }
    if (!definition.allowed.includes(name)) {
      problems.push(
        `${CAPABILITIES_ENV} names "${name}", which product ${product} does not allow (allowed: ${definition.allowed.join(", ")})`,
      );
      continue;
    }
    chosen.add(name);
  }
  for (const capability of chosen) {
    const needed = requiredCapability(capability);
    if (needed !== undefined && !chosen.has(needed))
      problems.push(
        `${CAPABILITIES_ENV} has "${capability}" but not "${needed}", which it needs`,
      );
  }
  if (chosen.size === 0 && problems.length === 0)
    problems.push(`${CAPABILITIES_ENV} names no capability`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, product, capabilities: createCapabilitySet(chosen) };
}

/** The problems of the settings, for the check at start (src/deploy/startup.ts). Empty when they are fine. */
export function capabilityConfigProblems(env: Env): string[] {
  const config = resolveCapabilityConfig(env);
  return config.ok ? [] : config.problems;
}
