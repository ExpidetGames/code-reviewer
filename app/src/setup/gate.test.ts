// SPDX-License-Identifier: Apache-2.0

// Pins down the setup gate decision for a fresh installation, an existing installation and a set up
// instance. The rule is default closed while the setup is open: only what is listed passes.
import { describe, expect, it } from "vitest";
import { decideSetupGate } from "./gate.ts";

const FRESH = { kind: "fresh" } as const;
const EXISTING = { kind: "existing" } as const;
const COMPLETED = { kind: "completed" } as const;

function decide(
  state: typeof FRESH | typeof EXISTING | typeof COMPLETED,
  pathname: string,
  method = "GET",
) {
  return decideSetupGate({ pathname, method, state }).kind;
}

describe("the setup gate on a fresh installation", () => {
  // #97-SU-03
  it("shows the setup instead of any page", () => {
    for (const path of [
      "/",
      "/projects",
      "/runs/42",
      "/login",
      "/admin",
      "/anything",
    ])
      expect(decide(FRESH, path)).toBe("show_setup");
  });

  // #97-SU-03
  it("answers setup_required for the API, the webhooks and the runner API", () => {
    for (const path of [
      "/api/projects",
      "/api/runs",
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/api/operator/v1/workspaces",
      "/api/auth/sign-in/email",
      "/api/review-settings",
      "/api",
    ])
      expect(decide(FRESH, path, "POST")).toBe("setup_required");
  });

  // #97-SU-03
  it("lets the health check, the framework files and the setup itself through", () => {
    for (const path of [
      "/api/health",
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/setup",
      "/api/setup/code",
      "/api/setup/complete",
    ])
      expect(decide(FRESH, path, "POST")).toBe("pass");
  });

  it("answers setup_required to a post to a page, such as a Server Function", () => {
    expect(decide(FRESH, "/login", "POST")).toBe("setup_required");
    expect(decide(FRESH, "/", "PUT")).toBe("setup_required");
  });

  it("shows the setup for HEAD requests too", () => {
    expect(decide(FRESH, "/", "HEAD")).toBe("show_setup");
  });

  it("does not let a look-alike path through", () => {
    for (const path of [
      "/setup/x",
      "/Setup",
      "/setupx",
      "/api/setupx",
      "/api/healthz",
      "/api/health/x",
      "/_nextfoo",
    ])
      expect(decide(FRESH, path)).not.toBe("pass");
  });
});

describe("the setup gate on an existing installation", () => {
  // #97-SU-22
  it("keeps the webhooks and the runner API working", () => {
    for (const path of [
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/api/runners/v1/jobs/1/heartbeat",
    ])
      expect(decide(EXISTING, path, "POST")).toBe("pass");
  });

  // #97-SU-22
  it("gates the web UI and the UI APIs like a fresh installation", () => {
    expect(decide(EXISTING, "/")).toBe("show_setup");
    expect(decide(EXISTING, "/projects")).toBe("show_setup");
    expect(decide(EXISTING, "/api/projects", "POST")).toBe("setup_required");
    expect(decide(EXISTING, "/api/integrations/sync", "POST")).toBe(
      "setup_required",
    );
    expect(decide(EXISTING, "/api/auth/sign-in/social", "POST")).toBe(
      "setup_required",
    );
  });

  it("does not open look-alikes of the webhook and runner paths", () => {
    for (const path of [
      "/api/webhooksx",
      "/api/runnersx/v1/claim",
      "/API/webhooks/x",
    ])
      expect(decide(EXISTING, path, "POST")).toBe("setup_required");
  });
});

describe("the setup gate on a set up instance", () => {
  // #97-SU-14
  it("answers 404 for the setup page and the setup API", () => {
    for (const path of [
      "/setup",
      "/api/setup/code",
      "/api/setup/complete",
      "/api/setup",
    ])
      expect(decide(COMPLETED, path, "POST")).toBe("not_found");
  });

  it("leaves every other path alone", () => {
    for (const path of [
      "/",
      "/login",
      "/projects",
      "/api/projects",
      "/api/health",
      "/api/webhooks/github-app",
      "/setupx",
    ])
      expect(decide(COMPLETED, path)).toBe("pass");
  });
});
