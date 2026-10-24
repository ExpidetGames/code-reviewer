// SPDX-License-Identifier: LicenseRef-Proprietary

// The removal of the stored keys, at the end of the "LLM" page (#658; it was on "Advanced" before): one danger zone
// for each provider that has a key (#426), for an Admin or an Owner (`manage_llm_key`). All providers are rendered, so a
// card that removed its key stays mounted to confirm it (`RemoveWorkspaceKey` owns whether the key is still there).
import { llmProviderDescriptors } from "../providers/index.ts";
import type { InstanceAccess } from "../access.ts";
import type { LlmKeyApi } from "./api.ts";
import { RemoveWorkspaceKey } from "./remove-workspace-key.tsx";

export type RemovableKey = {
  provider: string;
  configured: boolean;
  /** The name of a catalog provider (#555) as the catalog spells it; the registry's providers are named by the registry. */
  label?: string;
};

export function RemoveWorkspaceKeys({
  workspaceSlug,
  keys,
  instanceAccess = null,
  api,
}: {
  workspaceSlug: string;
  /** Every registered provider and whether a workspace key of it is saved (nothing to remove otherwise). */
  keys: ReadonlyArray<RemovableKey>;
  /**
   * Set when this instance provides the access of the workspace (its key mode is managed, `instanceAccessOf`): the provider
   * behind that access is not for the workspace to read, so no card names one. A key the workspace stored earlier is still
   * listed, by the words "the stored key" (it can be removed, it is not used), and only while it exists.
   */
  instanceAccess?: InstanceAccess | null;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return keys
    .filter(({ configured }) => instanceAccess === null || configured)
    .map(({ provider, configured, label }) => (
      <RemoveWorkspaceKey
        key={provider}
        workspaceSlug={workspaceSlug}
        provider={provider}
        label={
          instanceAccess === null
            ? (label ?? llmProviderDescriptors.labelOf(provider))
            : null
        }
        keyConfigured={configured}
        {...(api === undefined ? {} : { api })}
      />
    ));
}
