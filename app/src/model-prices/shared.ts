// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server for the price routes of the admin portal (#549): the service on the server's database,
// with the audit line of a write on the server's log, which is the operator's: it names the person, the provider, the model
// and the prices.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { createModelPriceService, type ModelPriceService } from "./service.ts";

export function getModelPriceService(): ModelPriceService {
  return createModelPriceService({ db: getDatabase() });
}
