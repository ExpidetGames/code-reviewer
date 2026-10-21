// SPDX-License-Identifier: Apache-2.0

// The wiring of the cost policy of a native job on the running server (#553): the price service and the instance settings on
// the server's database. The claim imports this module and never the price module, which only the admin portal may use.
import "server-only";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getModelPriceService } from "../model-prices/shared.ts";
import { createNativeCostService, type NativeCostService } from "./service.ts";
import { nativeCostRegistryFor } from "./registry-addresses.ts";

export function getNativeCost(): NativeCostService {
  return createNativeCostService({
    prices: getModelPriceService(),
    settings: createInstanceSettingsRepository(getDatabase()),
    catalog: createModelsDevRepository(getDatabase()),
    // The providers of the app's registry keep their wires until #556; a selection that names one is never native, unless
    // the switch is on (`NATIVE_OPENCODE_PROVIDERS`, switch.ts, default off): then neither is legacy and the claim of a
    // Dynamic job on either carries the entry and the cost policy of the catalog. Their addresses are pinned either way.
    ...nativeCostRegistryFor(process.env),
  });
}
