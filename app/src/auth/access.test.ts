// SPDX-License-Identifier: Apache-2.0

// Pins down which paths need a session and what an unauthenticated request gets back. The rule is
// default deny: only the paths on the public list are open, everything else, including paths that
// do not exist yet, needs a session.
import { describe, expect, it } from "vitest";
import { decideAccess, isPublicPath, PUBLIC_PATHS } from "./access.ts";

describe("which paths are public", () => {
  // CR-18-T07
  it.each([
    "/login",
    "/api/health",
    "/api/auth/sign-in/social",
    "/api/auth/callback/github",
    "/api/auth",
    "/api/runners/v1/claim",
    "/api/runners/v1/jobs/42/heartbeat",
    "/api/webhooks/github-app",
  ])("lets %s through without a session", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  // CR-18-T07
  it.each([
    "/",
    "/projects",
    "/projects/42/reviews",
    "/api",
    "/api/jobs",
    "/api/anything-new",
    "/settings",
    "/no-access",
    "/w/acme/projects",
    "/api/w/acme/runs",
    "/api/workspaces",
    "/api/invitations/accept",
    "/invitations",
  ])("requires a session for %s", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  // CR-18-T07
  it.each([
    "/loginx",
    "/login/extra",
    "/login/",
    "/api/healthz",
    "/api/health/details",
    "/api/authentication",
    "/api/auth-admin",
    "/api/runnersx",
    "/api/runners-admin/jobs",
    "/api/webhooksx",
    "/API/health",
    "/Login",
    "//api/health",
    "/api//runners/v1/claim",
    "/api/%72unners/v1/claim",
    "/x/api/runners/v1/claim",
  ])("does not treat the look-alike %s as public", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  it("keeps the list of public paths small and explicit", () => {
    expect(PUBLIC_PATHS).toEqual([
      { path: "/login", match: "exact" },
      { path: "/api/health", match: "exact" },
      { path: "/setup", match: "exact" },
      { path: "/api/setup", match: "prefix" },
      { path: "/api/auth", match: "prefix" },
      { path: "/reset-password", match: "exact" },
      { path: "/api/password-reset", match: "exact" },
      { path: "/sign-up", match: "exact" },
      { path: "/api/sign-up", match: "exact" },
      { path: "/verify-email", match: "exact" },
      { path: "/api/verify-email", match: "prefix" },
      { path: "/invitation", match: "exact" },
      { path: "/api/runners", match: "prefix" },
      { path: "/api/webhooks", match: "prefix" },
    ]);
  });
});

describe("what a request without a session gets", () => {
  // CR-18-T07
  it("is sent to the login page for a page", () => {
    expect(decideAccess({ pathname: "/", authenticated: false })).toEqual({
      kind: "redirect-to-login",
    });
    expect(
      decideAccess({ pathname: "/projects/42", authenticated: false }),
    ).toEqual({ kind: "redirect-to-login" });
  });

  // CR-18-T07
  it("is answered with 401 for a data route", () => {
    expect(
      decideAccess({ pathname: "/api/jobs", authenticated: false }),
    ).toEqual({ kind: "unauthorized" });
    expect(decideAccess({ pathname: "/api", authenticated: false })).toEqual({
      kind: "unauthorized",
    });
  });

  it("passes a public path without a session", () => {
    expect(decideAccess({ pathname: "/login", authenticated: false })).toEqual({
      kind: "allow",
    });
    expect(
      decideAccess({ pathname: "/api/runners/v1/claim", authenticated: false }),
    ).toEqual({ kind: "allow" });
  });

  it("passes every path with a valid session", () => {
    expect(decideAccess({ pathname: "/", authenticated: true })).toEqual({
      kind: "allow",
    });
    expect(
      decideAccess({ pathname: "/api/jobs", authenticated: true }),
    ).toEqual({
      kind: "allow",
    });
  });
});
