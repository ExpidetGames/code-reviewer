// The calls the admin pages make to the portal's own data route (src/admin/http.ts). Browser side;
// nothing throws, a failure is a stable code the page translates (messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { AdminSettingsView } from "../service.ts";

export type SettingChange =
  | { tenancy: "single" | "multi" }
  | {
      signUp:
        | { kind: "everyone" }
        | { kind: "emails" | "domains"; entries: string[] };
    }
  | { signInMethods: { emailPassword: boolean; github: boolean } }
  | { limits: { maxWorkspacesPerUser: number } };

export type AdminApi = {
  change(
    change: SettingChange,
  ): Promise<RequestResult<{ ok: true; settings: AdminSettingsView }>>;
};

export function createAdminApi(fetchImpl: FetchLike): AdminApi {
  return {
    change: (change) =>
      requestJson(fetchImpl, "PUT", "/api/admin/settings", change),
  };
}

export const browserAdminApi = createAdminApi((url, init) => fetch(url, init));
