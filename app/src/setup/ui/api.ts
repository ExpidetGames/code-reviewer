// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the code form and the wizard make to the app's own routes (src/setup/http.ts). Browser
// side; nothing throws, a failure is a stable code the page translates (messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

export type WizardRequest = {
  tenancy: "single" | "multi";
  signUp:
    { kind: "everyone" } | { kind: "emails" | "domains"; entries: string[] };
  admin: { email: string; password: string };
};

export type SetupApi = {
  submitCode(code: string): Promise<RequestResult<{ ok: true }>>;
  complete(
    body: WizardRequest,
  ): Promise<RequestResult<{ ok: true; redirectTo: string }>>;
};

export function createSetupApi(fetchImpl: FetchLike): SetupApi {
  return {
    submitCode: (code) =>
      requestJson(fetchImpl, "POST", "/api/setup/code", { code }),
    complete: (body) =>
      requestJson(fetchImpl, "POST", "/api/setup/complete", body),
  };
}

export const browserSetupApi = createSetupApi((url, init) => fetch(url, init));
