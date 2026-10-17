// SPDX-License-Identifier: Apache-2.0

// The registry of providers: a validated, closed list of adapters and the lookups every caller uses. Built once
// at module load from the adapters named in `index.ts` (descriptors, client-safe) and `server.ts` (adapters with
// their network operations); a tuple that is not a valid list stops the app at start, not at the first request.
// A test builds a registry of its own with an adapter that exists only there (`fake-adapter.ts`).
//
// Nothing here knows a provider by name. The first adapter of the list is the default provider: the one a
// request that names none, the instance's own key and the cost guard use until a project can choose (the next
// issues of epic #420).
import {
  COST_REPORTING_VALUES,
  type LlmProviderAdapter,
  type LlmProviderDescriptor,
} from "./types.ts";

export const PROVIDER_REGISTRY_ERROR_CODES = [
  "registry_empty",
  "provider_member_missing",
  "provider_member_invalid",
  "provider_id_duplicate",
  "provider_secret_name_taken",
] as const;
export type ProviderRegistryErrorCode =
  (typeof PROVIDER_REGISTRY_ERROR_CODES)[number];

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;
  constructor(code: ProviderRegistryErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

/** The shape of a provider id: it is stored as the binding of a key and travels in a job's input. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const DESCRIPTOR_MEMBERS = [
  "id",
  "label",
  "apiBaseUrl",
  "secretNames",
  "checkModelId",
  "suggestedModels",
  "priceOf",
  "defaultModels",
  "costReporting",
] as const;
const OPERATION_MEMBERS = ["testKey", "checkModelCapabilities"] as const;

type Candidate = Record<string, unknown>;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isHttpUrl = (value: string): boolean => {
  // `URL.canParse` is not in every browser this module reaches (it is imported by client components).
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};
const isRecord = (value: unknown): value is Candidate =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(id: string, member: string): never {
  throw new ProviderRegistryError(
    "provider_member_invalid",
    `provider "${id}": ${member}`,
  );
}

function checkMembers(
  candidate: unknown,
  members: readonly string[],
): asserts candidate is Candidate {
  if (!isRecord(candidate))
    throw new ProviderRegistryError(
      "provider_member_missing",
      "a provider is not an object",
    );
  for (const member of members)
    if (candidate[member] === undefined)
      throw new ProviderRegistryError(
        "provider_member_missing",
        `provider "${String(candidate.id)}": ${member}`,
      );
}

function checkDescriptor(candidate: Candidate): void {
  const id = String(candidate.id);
  if (
    typeof candidate.id !== "string" ||
    !PROVIDER_ID_PATTERN.test(candidate.id)
  )
    invalid(id, "id");
  if (!isText(candidate.label)) invalid(id, "label");
  if (!isText(candidate.apiBaseUrl) || !isHttpUrl(candidate.apiBaseUrl))
    invalid(id, "apiBaseUrl");
  const secrets = candidate.secretNames;
  if (
    !isRecord(secrets) ||
    !isText(secrets.workspace) ||
    !isText(secrets.operator)
  )
    invalid(id, "secretNames");
  if (typeof candidate.checkModelId !== "function") invalid(id, "checkModelId");
  if (typeof candidate.priceOf !== "function") invalid(id, "priceOf");
  const checkModelId = candidate.checkModelId as (id: string) => boolean;
  const suggested = candidate.suggestedModels;
  if (
    !Array.isArray(suggested) ||
    !suggested.every(
      (model): model is string =>
        typeof model === "string" && checkModelId(model),
    )
  )
    invalid(id, "suggestedModels");
  const defaults = candidate.defaultModels;
  if (
    !isRecord(defaults) ||
    typeof defaults.diff !== "string" ||
    typeof defaults.dynamic !== "string" ||
    !checkModelId(defaults.diff) ||
    !checkModelId(defaults.dynamic)
  )
    invalid(id, "defaultModels");
  if (!COST_REPORTING_VALUES.some((value) => value === candidate.costReporting))
    invalid(id, "costReporting");
}

function checkOperations(candidate: Candidate): void {
  for (const member of OPERATION_MEMBERS)
    if (typeof candidate[member] !== "function")
      invalid(String(candidate.id), member);
}

type IdOf<D> = D extends { id: infer I } ? I : never;
/** The providers whose id can be `I` (a provider typed with a plain `string` id can be any). */
type ProviderById<D, I> = D extends { id: infer X }
  ? I extends X
    ? D
    : never
  : never;

export type ProviderRegistry<P extends readonly LlmProviderDescriptor[]> = {
  /** The providers in the order they were listed; the first is the default. */
  readonly providers: P;
  readonly ids: { readonly [K in keyof P]: P[K]["id"] };
  readonly defaultProvider: P[0];
  /** The provider with this id; throws for an id that is not in the registry (a programming error). */
  get<I extends IdOf<P[number]>>(id: I): ProviderById<P[number], I>;
  /** The provider a request or a stored binding names, or undefined: trimmed, case-insensitive, strings only. */
  find(raw: unknown): P[number] | undefined;
  /** The label for the copy of a stored binding; the binding itself when no provider has that id. */
  labelOf(binding: string): string;
  readonly workspaceSecretNames: {
    readonly [K in keyof P]: P[K]["secretNames"]["workspace"];
  };
  readonly operatorSecretNames: {
    readonly [K in keyof P]: P[K]["secretNames"]["operator"];
  };
};

function build<const P extends readonly LlmProviderDescriptor[]>(
  providers: P,
): ProviderRegistry<P> {
  const ids = new Set<string>();
  const workspaceNames = new Set<string>();
  const operatorNames = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id))
      throw new ProviderRegistryError(
        "provider_id_duplicate",
        `provider "${provider.id}"`,
      );
    ids.add(provider.id);
    for (const [names, name] of [
      [workspaceNames, provider.secretNames.workspace],
      [operatorNames, provider.secretNames.operator],
    ] as const) {
      if (names.has(name))
        throw new ProviderRegistryError(
          "provider_secret_name_taken",
          `provider "${provider.id}": ${name}`,
        );
      names.add(name);
    }
  }

  const byId = new Map<string, P[number]>(
    providers.map((provider) => [provider.id, provider]),
  );
  return {
    providers,
    ids: providers.map((provider) => provider.id) as never,
    defaultProvider: providers[0] as P[0],
    get(id) {
      const found = byId.get(id);
      if (found === undefined)
        throw new ProviderRegistryError(
          "provider_member_invalid",
          `no provider "${id}"`,
        );
      return found as never;
    },
    find(raw) {
      if (typeof raw !== "string") return undefined;
      return byId.get(raw.trim().toLowerCase());
    },
    labelOf: (binding) => byId.get(binding)?.label ?? binding,
    workspaceSecretNames: providers.map(
      (provider) => provider.secretNames.workspace,
    ) as never,
    operatorSecretNames: providers.map(
      (provider) => provider.secretNames.operator,
    ) as never,
  };
}

function validated<P extends readonly unknown[]>(
  providers: P,
  members: readonly string[],
  operations: boolean,
): void {
  if (providers.length === 0)
    throw new ProviderRegistryError("registry_empty", "no provider listed");
  for (const candidate of providers) {
    checkMembers(candidate, members);
    checkDescriptor(candidate);
    if (operations) checkOperations(candidate);
  }
}

/** The registry of descriptors: what a client component may import. Throws `ProviderRegistryError`. */
export function createProviderRegistry<
  const P extends readonly LlmProviderDescriptor[],
>(providers: P): ProviderRegistry<P> {
  validated(providers, DESCRIPTOR_MEMBERS, false);
  return build(providers);
}

/** The registry of complete adapters (descriptor and network operations); server code only. */
export function createAdapterRegistry<
  const P extends readonly LlmProviderAdapter[],
>(providers: P): ProviderRegistry<P> {
  validated(providers, [...DESCRIPTOR_MEMBERS, ...OPERATION_MEMBERS], true);
  return build(providers);
}
