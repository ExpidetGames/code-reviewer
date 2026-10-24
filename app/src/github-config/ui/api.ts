// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the GitHub section of the admin portal makes to its own data routes (src/github-config/http.ts).
// Browser side; nothing throws, a failure is a stable code the page translates (messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { GithubConfigView } from "../service.ts";

/** What the manual form sends. An empty secret keeps the stored one while the App id (and client id) is unchanged. */
export type AppChange = {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  privateApp: boolean;
};

export type UserAuthorizationChange = {
  clientId: string;
  clientSecret: string;
};

export type ManifestStart = { postUrl: string; manifest: string };

export type GithubApi = {
  saveApp(
    app: AppChange,
  ): Promise<RequestResult<{ ok: true; github: GithubConfigView }>>;
  saveUserAuthorization(
    input: UserAuthorizationChange,
  ): Promise<RequestResult<{ ok: true; github: GithubConfigView }>>;
  setPrivateApp(
    privateApp: boolean,
  ): Promise<RequestResult<{ ok: true; github: GithubConfigView }>>;
  /** Starts the manifest flow: the manifest and the address of GitHub's creation page to post it to. */
  startManifest(input: {
    name: string;
    organization: string;
    replace: boolean;
  }): Promise<RequestResult<{ ok: true } & ManifestStart>>;
  /** Asks GitHub which permissions the App lacks. */
  check(): Promise<RequestResult<{ ok: true; missing: string[] }>>;
};

export function createGithubApi(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): GithubApi {
  return {
    saveApp: (app) =>
      requestJson(fetchImpl, "PUT", "/api/admin/github", { app }),
    saveUserAuthorization: (input) =>
      requestJson(fetchImpl, "PUT", "/api/admin/github", {
        userAuthorization: input,
      }),
    setPrivateApp: (privateApp) =>
      requestJson(fetchImpl, "PUT", "/api/admin/github", { privateApp }),
    startManifest: (input) =>
      requestJson(fetchImpl, "POST", "/api/admin/github/manifest", input),
    check: () => requestJson(fetchImpl, "POST", "/api/admin/github/check", {}),
  };
}

export const browserGithubApi: GithubApi = createGithubApi();

/** Sends the browser to an address (GitHub's authorization page). Replaced in tests. */
export function goTo(url: string): void {
  window.location.assign(url);
}

/**
 * Posts the manifest to GitHub the way GitHub documents it: a form with one field, `manifest`, submitted
 * by the browser to the address that carries the state. Replaced in tests.
 */
export function postManifestToGithub(postUrl: string, manifest: string): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = postUrl;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = manifest;
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}
