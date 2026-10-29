// SPDX-License-Identifier: LicenseRef-Proprietary

// The manifest the admin portal posts to GitHub: every address from the configured public URL, the
// permissions and events of the App, public or private by tenancy, and the helper that names what an
// imported App lacks.
import { describe, expect, it } from "vitest";
import { JOB_TOKEN_PERMISSIONS } from "./job-access.ts";
import {
  APP_NAME_MAX_LENGTH,
  buildAppManifest,
  CHECK_RUN_PERMISSIONS,
  missingPermissions,
  suggestedAppName,
} from "./manifest.ts";
import { getProductIdentity } from "../../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

const PUBLIC_URL = "https://reviews.example.com";

describe("the GitHub App manifest", () => {
  // #102-GH-01
  it("derives the webhook, redirect, callback and setup addresses from the public URL of a multi-tenant instance", () => {
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "multi",
      name: "Code Reviewer",
    });

    expect(manifest.url).toBe(PUBLIC_URL);
    expect(manifest.hook_attributes).toEqual({
      url: `${PUBLIC_URL}/api/webhooks/github-app`,
      active: true,
    });
    expect(manifest.redirect_url).toBe(
      `${PUBLIC_URL}/api/admin/github/manifest/callback`,
    );
    expect(manifest.callback_urls).toEqual([
      `${PUBLIC_URL}/api/auth/callback/github`,
    ]);
    expect(manifest.setup_url).toBe(`${PUBLIC_URL}/github/connected`);
    expect(manifest.public).toBe(true);
  });

  // #102-GH-01
  it("makes the App private on a single-tenant instance", () => {
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "Code Reviewer",
    });

    expect(manifest.public).toBe(false);
  });

  // #102-GH-01
  // #405-T13
  it("asks for the repository permissions of a review job plus Checks, Email addresses and Members", () => {
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "Code Reviewer",
    });

    expect(manifest.default_permissions).toEqual({
      ...JOB_TOKEN_PERMISSIONS,
      checks: "write",
      emails: "read",
      members: "read",
    });
    expect(manifest.default_events).toEqual(["pull_request", "issue_comment"]);
  });

  // #405-T13
  it("asks for the Checks permission on top of a job token's, which a Worker never holds", () => {
    expect(CHECK_RUN_PERMISSIONS).toEqual({ checks: "write" });
    expect(JOB_TOKEN_PERMISSIONS).not.toHaveProperty("checks");
  });

  it("does not ask GitHub to authorize a person during the installation", () => {
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: PUBLIC_URL,
      tenancy: "single",
      name: "x",
    });

    expect(manifest.request_oauth_on_install).toBe(false);
  });

  it("ignores a trailing slash of the public URL", () => {
    const manifest = buildAppManifest({
      product: PRODUCT,
      publicUrl: `${PUBLIC_URL}/`,
      tenancy: "single",
      name: "x",
    });

    expect(manifest.hook_attributes.url).toBe(
      `${PUBLIC_URL}/api/webhooks/github-app`,
    );
  });
});

describe("the suggested App name", () => {
  it("names the host of the instance and stays within what GitHub accepts", () => {
    expect(suggestedAppName(PRODUCT, PUBLIC_URL)).toBe(
      "Code Reviewer reviews.example.com",
    );
    const long = suggestedAppName(
      PRODUCT,
      "https://a-very-long-subdomain.example-company.com",
    );
    expect(long.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
    expect(long.startsWith("Code Reviewer")).toBe(true);
  });
});

describe("the permissions an App lacks", () => {
  // #405-T13
  it("lists the Checks, account and organization permissions of an App that was made by hand without them", () => {
    expect(
      missingPermissions({
        pull_requests: "write",
        issues: "write",
        contents: "read",
        metadata: "read",
      }),
    ).toEqual(["checks", "emails", "members"]);
  });

  it("lists a permission whose level is too low and nothing for a complete App", () => {
    expect(
      missingPermissions({
        pull_requests: "read",
        issues: "write",
        contents: "read",
        metadata: "read",
        checks: "write",
        emails: "read",
        members: "read",
      }),
    ).toEqual(["pull_requests"]);
    expect(
      missingPermissions({
        pull_requests: "write",
        issues: "write",
        contents: "write",
        metadata: "read",
        checks: "write",
        emails: "read",
        members: "write",
      }),
    ).toEqual([]);
  });
});
