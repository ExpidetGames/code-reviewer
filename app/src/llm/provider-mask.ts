// SPDX-License-Identifier: Apache-2.0

// The names of the registered providers, taken out of a text a member of a workspace on the operator's key can read (#435,
// ADR 0005, 2.17). Used where a result is stored (`runner-api/report.ts`) and where a run is read (`runs/run-view.ts`), so a
// row stored before the mask existed is masked as well.
import { maskProviderInText } from "./access.ts";
import { llmProviderDescriptors } from "./providers/index.ts";

/** Every registered provider, by its id and by the name a person reads. */
const PROVIDER_NAMES = llmProviderDescriptors.ids.flatMap((id) => [
  id,
  llmProviderDescriptors.labelOf(id),
]);

/** `text` without the name of any provider (`[provider]`), in any letter case. */
export function maskProvidersInText(text: string): string {
  return maskProviderInText(text, PROVIDER_NAMES);
}
