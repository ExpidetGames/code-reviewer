// SPDX-License-Identifier: Apache-2.0

// The calls the admin pages make to the portal's own data route (src/admin/http.ts). Browser side;
// nothing throws, a failure is a stable code the page translates (messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { AdminSettingsView } from "../service.ts";

/** What the mail form sends. An empty or missing `password` keeps the stored one. */
export type SmtpChange = {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user: string;
  password?: string;
  clearPassword?: boolean;
  senderAddress: string;
  senderName: string;
  allowSelfSigned: boolean;
  /** Set only after the admin ticked the second warning: the login goes out without encryption. */
  allowPlainTextLogin: boolean;
};

/** The result of the test mail: it worked, or a class of failure with a safe detail. */
export type TestMailAnswer =
  { ok: true } | { ok: false; error: string; detail: string | null };

export type SettingChange =
  | { tenancy: "single" | "multi" }
  | {
      signUp:
        | { kind: "everyone" }
        | { kind: "emails" | "domains"; entries: string[] };
    }
  | { signInMethods: { emailPassword: boolean; github: boolean } }
  | { limits: { maxWorkspacesPerUser: number } }
  /** The Dynamic Review rollout gate of the instance. */
  | { dynamicReview: { enabled: boolean } }
  /** `null` removes the mail server. */
  | { smtp: SmtpChange | null }
  /** The operator's own LLM key (write-only); `null` removes it. */
  | { operatorLlmKey: { apiKey: string } | null }
  /** Hides the notice that the import of an existing installation left. */
  | { importNotice: { dismiss: true } };

export type AdminApi = {
  change(
    change: SettingChange,
  ): Promise<RequestResult<{ ok: true; settings: AdminSettingsView }>>;
  /** Sends a test mail to the admin's own address with the saved settings. */
  testMail(): Promise<RequestResult<TestMailAnswer>>;
};

export function createAdminApi(fetchImpl: FetchLike): AdminApi {
  return {
    change: (change) =>
      requestJson(fetchImpl, "PUT", "/api/admin/settings", change),
    testMail: () => requestJson(fetchImpl, "POST", "/api/admin/mail/test", {}),
  };
}

export const browserAdminApi = createAdminApi((url, init) => fetch(url, init));
