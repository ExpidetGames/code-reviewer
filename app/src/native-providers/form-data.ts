// SPDX-License-Identifier: Apache-2.0

// What the project settings form of a workspace on its own key is given about the models.dev catalog (#555): the catalog providers
// the workspace holds a key for (the other providers are chosen on the LLM access page, where the key is entered), the provider the
// project has now (kept in the list even when it has no key or the catalog dropped it, so the form can say so instead of
// pretending), the token cap of a run on an own key and whether billing is on. A workspace on the operator's key gets nothing and
// nothing is read for it: it never sees a provider or a model id (principle 2 of epic #420).
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import type { NativeProviderView } from "./catalog.ts";
import type { ProviderKeyStatus } from "../llm/workspace-key.ts";

/** A provider of the form's select: the id it stores, the name people read, whether the workspace holds a readable key. */
export type NativeProviderOption = {
  id: string;
  label: string;
  hasKey: boolean;
};

export type NativeFormData = {
  /** The catalog providers to offer next to the registry's, in the order of their names. */
  providers: NativeProviderOption[];
  /** The token cap that bounds a run with no listed price (the instance setting). */
  tokenCap: number;
  billingOn: boolean;
};

export async function nativeFormDataFor(
  form: { managed: boolean; currentProvider: string | undefined },
  deps: {
    catalog: { providers(): Promise<readonly NativeProviderView[]> };
    keys: { nativeStatuses(): Promise<readonly ProviderKeyStatus[]> };
    billingOn(): Promise<boolean>;
    tokenCap(): Promise<number>;
  },
): Promise<NativeFormData | undefined> {
  if (form.managed) return undefined;
  const [offered, statuses, billingOn, tokenCap] = await Promise.all([
    deps.catalog.providers(),
    deps.keys.nativeStatuses(),
    deps.billingOn(),
    deps.tokenCap(),
  ]);
  const keyed = new Set(
    statuses
      .filter((entry) => entry.status.state === "configured")
      .map((entry) => entry.provider),
  );
  const providers: NativeProviderOption[] = offered
    .filter((provider) => keyed.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      hasKey: true,
    }));
  const current = form.currentProvider;
  if (
    current !== undefined &&
    !llmProviderDescriptors.ids.some((id) => id === current) &&
    !providers.some((provider) => provider.id === current)
  )
    providers.push({
      id: current,
      label:
        offered.find((provider) => provider.id === current)?.label ?? current,
      hasKey: keyed.has(current),
    });
  return { providers, tokenCap, billingOn };
}
