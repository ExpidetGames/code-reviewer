// SPDX-License-Identifier: LicenseRef-Proprietary

// The names the LLM keys are stored under, from the provider registry (`providers/`): adding a provider adds its names. The
// secret store knows none of them (#715, cut 8); the code that composes a store for LLM keys passes these.
import type { NativeKeySecretName } from "../native-providers/lookup.ts";
import { llmProviderDescriptors } from "./providers/index.ts";

/** The operator's LLM key of each provider (used by the workspaces whose key mode is `managed`, #276). */
export const OPERATOR_LLM_KEY_NAMES =
  llmProviderDescriptors.operatorSecretNames;
export type OperatorLlmKeyName = (typeof OPERATOR_LLM_KEY_NAMES)[number];

/** The workspace's own LLM key of each provider of the registry. */
export const WORKSPACE_LLM_KEY_NAMES =
  llmProviderDescriptors.workspaceSecretNames;
export type WorkspaceLlmKeyName =
  | (typeof WORKSPACE_LLM_KEY_NAMES)[number]
  /**
   * The key of a catalog provider (#555), `llm_api_key.<slug>`. Those names are not a closed list: the providers are data
   * (`contracts/opencode-providers.v1.json`), so the slot is named after the slug and the store accepts any slug.
   */
  | NativeKeySecretName;
