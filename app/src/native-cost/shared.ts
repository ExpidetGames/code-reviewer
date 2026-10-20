// SPDX-License-Identifier: Apache-2.0

// The wiring of the cost policy of a native job on the running server (#553): the price service and the instance settings on
// the server's database. The claim imports this module and never the price module, which only the admin portal may use.
import "server-only";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { getModelPriceService } from "../model-prices/shared.ts";
import { createNativeCostService, type NativeCostService } from "./service.ts";

export function getNativeCost(): NativeCostService {
  return createNativeCostService({
    prices: getModelPriceService(),
    settings: createInstanceSettingsRepository(getDatabase()),
    // The providers of the app's registry keep their wires until #556; a selection that names one is never native.
    legacyProviders: llmProviderDescriptors.ids,
  });
}
