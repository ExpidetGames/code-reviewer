// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App manifest flow of the fake GitHub, as GitHub documents it: the browser posts a manifest
// to `/settings/apps/new` (or the organization's address), the person confirms on a page, and GitHub
// sends the browser back to the manifest's `redirect_url` with a one-time `code` and the `state` it was
// given; the app then trades the code for the new app's credentials once
// (`POST /app-manifests/:code/conversions`). The fake creates a real RSA key pair for every app, so the
// App JWTs the app under test signs with the returned key are accepted by the GitHub App API part, and
// registers the new app's client credentials for the sign in part (`registry.ts`).
//
// State is in memory. Dummy values only. Failure injection (`fail({ pathIncludes: "/app-manifests/" })`)
// works as on every other path.
import { generateKeyPair, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { readForm, redirect, sendHtml, sendJson } from "./http.ts";
import {
  ownerIdFor,
  type AppRegistry,
  type FakeAppPermissionMap,
} from "./registry.ts";

const generateKeyPairAsync = promisify(generateKeyPair);

/** The parts of a manifest the fake looks at. */
export type FakeManifest = {
  name?: string;
  url?: string;
  redirect_url?: string;
  callback_urls?: string[];
  setup_url?: string;
  public?: boolean;
  hook_attributes?: { url?: string; active?: boolean };
  default_permissions?: Record<string, string>;
  default_events?: string[];
  [key: string]: unknown;
};

export type FakeManifestFlowControls = {
  /**
   * What the person's "Create GitHub App" button does: confirms the manifest that was posted to
   * `postUrl` (the address of the form, with its `state`) and resolves to the address the browser is
   * sent back to (the manifest's `redirect_url` with `code` and `state`).
   */
  confirmManifest(postUrl: string, manifest: string): Promise<URL>;
  /** Every manifest that was posted to a creation form, in order. */
  postedManifests(): FakeManifest[];
  /** The codes the conversion endpoint has been called with, in order (used or not). */
  conversionCodes(): string[];
};

export type ManifestPart = {
  controls: FakeManifestFlowControls;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean>;
  reset(): void;
};

const ACCOUNT_PERMISSION_NAMES = new Set(["emails", "members"]);

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "app" : slug;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

export function createManifestPart(
  registry: AppRegistry,
  baseUrl: () => string,
): ManifestPart {
  const pending = new Map<
    string,
    { manifest: FakeManifest; ownerLogin: string }
  >();
  const posted: FakeManifest[] = [];
  const codes: string[] = [];
  let counter = 910_000;

  function parseManifest(text: string | null): FakeManifest | null {
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null
        ? (value as FakeManifest)
        : null;
    } catch {
      return null;
    }
  }

  // The form GitHub shows: the manifest's name and a button, posting back to the fake.
  async function showForm(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    owner: string,
  ) {
    const form = await readForm(request);
    const manifest = parseManifest(form.get("manifest"));
    if (manifest === null || typeof manifest.redirect_url !== "string")
      return sendHtml(
        response,
        422,
        "<h1>Invalid manifest</h1><p>The manifest must be JSON with a redirect_url.</p>",
      );
    posted.push(manifest);
    const state = url.searchParams.get("state") ?? "";
    sendHtml(
      response,
      200,
      `<h1>Register new GitHub App</h1><p>${escapeHtml(String(manifest.name ?? ""))}</p>` +
        `<form method="post" action="/settings/apps/new/confirm">` +
        `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
        `<input type="hidden" name="state" value="${escapeHtml(state)}">` +
        `<input type="hidden" name="owner" value="${escapeHtml(owner)}">` +
        `<button type="submit">Create GitHub App</button></form>`,
    );
  }

  function confirm(
    form: URLSearchParams,
    response: ServerResponse,
  ): URL | undefined {
    const manifest = parseManifest(form.get("manifest"));
    if (manifest === null || typeof manifest.redirect_url !== "string") {
      sendHtml(response, 422, "<h1>Invalid manifest</h1>");
      return undefined;
    }
    const code = `manifest-code-${randomBytes(12).toString("hex")}`;
    pending.set(code, {
      manifest,
      ownerLogin: form.get("owner") || "fake-owner",
    });
    const target = new URL(manifest.redirect_url);
    target.searchParams.set("code", code);
    const state = form.get("state");
    if (state) target.searchParams.set("state", state);
    return target;
  }

  async function convert(code: string, response: ServerResponse) {
    codes.push(code);
    // A code works once, like GitHub's (it also expires after an hour).
    const entry = pending.get(code);
    pending.delete(code);
    if (entry === undefined)
      return sendJson(response, 404, { message: "Not Found" });
    const { manifest, ownerLogin } = entry;

    const name = String(manifest.name ?? "App");
    const permissions: FakeAppPermissionMap = {};
    const accountPermissions: FakeAppPermissionMap = {};
    for (const [key, level] of Object.entries(
      manifest.default_permissions ?? {},
    )) {
      if (level !== "read" && level !== "write" && level !== "admin") continue;
      (ACCOUNT_PERMISSION_NAMES.has(key) ? accountPermissions : permissions)[
        key
      ] = level;
    }
    const keys = await generateKeyPairAsync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    counter += 1;
    const id = String(counter);
    const slug = slugify(name);
    const clientId = `Iv1.${randomBytes(8).toString("hex")}`;
    const clientSecret = randomBytes(20).toString("hex");
    const webhookSecret = randomBytes(16).toString("hex");
    registry.add({
      id,
      slug,
      name,
      ownerLogin,
      ownerId: ownerIdFor(ownerLogin),
      publicKeyPem: keys.publicKey,
      clientId,
      clientSecret,
      webhookSecret,
      permissions,
      accountPermissions,
      events: manifest.default_events ?? [],
      callbackUrls: manifest.callback_urls ?? [],
      isPublic: manifest.public === true,
      setupUrl:
        typeof manifest.setup_url === "string" ? manifest.setup_url : null,
      createdFromManifest: true,
    });
    const now = new Date().toISOString();
    sendJson(response, 201, {
      id: Number(id),
      slug,
      node_id: `A_fake${id}`,
      owner: { login: ownerLogin, id: ownerIdFor(ownerLogin), type: "User" },
      name,
      description: "",
      external_url: manifest.url ?? "",
      html_url: `${baseUrl()}/apps/${slug}`,
      created_at: now,
      updated_at: now,
      permissions: { ...permissions, ...accountPermissions },
      events: manifest.default_events ?? [],
      client_id: clientId,
      client_secret: clientSecret,
      webhook_secret: webhookSecret,
      pem: keys.privateKey,
    });
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = request.method ?? "GET";
    const path = url.pathname;
    if (method === "POST" && path === "/settings/apps/new") {
      await showForm(request, response, url, "fake-owner");
      return true;
    }
    const organization = /^\/organizations\/([^/]+)\/settings\/apps\/new$/.exec(
      path,
    );
    if (method === "POST" && organization) {
      await showForm(
        request,
        response,
        url,
        decodeURIComponent(organization[1] ?? ""),
      );
      return true;
    }
    if (method === "POST" && path === "/settings/apps/new/confirm") {
      const target = confirm(await readForm(request), response);
      if (target !== undefined) redirect(response, target);
      return true;
    }
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (method === "POST" && conversion) {
      await convert(decodeURIComponent(conversion[1] ?? ""), response);
      return true;
    }
    return false;
  }

  const controls: FakeManifestFlowControls = {
    async confirmManifest(postUrl, manifest) {
      const shown = new URL(postUrl);
      // The form is posted to the address the app gave, like the browser does, ...
      const form = await fetch(postUrl, {
        method: "POST",
        body: new URLSearchParams({ manifest }),
      });
      if (form.status !== 200)
        throw new Error(
          `The fake GitHub refused the manifest (status ${String(form.status)})`,
        );
      // ... and the button of the page it answers with confirms it.
      const organization =
        /^\/organizations\/([^/]+)\//.exec(shown.pathname)?.[1] ?? "fake-owner";
      const result = await fetch(`${baseUrl()}/settings/apps/new/confirm`, {
        method: "POST",
        body: new URLSearchParams({
          manifest,
          state: shown.searchParams.get("state") ?? "",
          owner: decodeURIComponent(organization),
        }),
        redirect: "manual",
      });
      const location = result.headers.get("location");
      if (result.status !== 302 || !location)
        throw new Error(
          `The fake GitHub did not redirect (status ${String(result.status)})`,
        );
      return new URL(location);
    },
    postedManifests: () => [...posted],
    conversionCodes: () => [...codes],
  };

  return {
    controls,
    handle,
    reset() {
      pending.clear();
      posted.length = 0;
      codes.length = 0;
    },
  };
}
