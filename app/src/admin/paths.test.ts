// SPDX-License-Identifier: Apache-2.0

// Pins down which request paths belong to the admin portal. The rule has to hold for every spelling
// that Next.js would route to an admin page or route: a path the proxy did not recognize as an admin
// path would reach the portal without the 404 for people who are not admins.
import { describe, expect, it } from "vitest";
import {
  isAdminPath,
  isInternalPortalPath,
  portalRewriteTarget,
} from "./paths.ts";

describe("which paths belong to the admin portal", () => {
  it.each([
    "/admin",
    "/admin/setup",
    "/admin/setup/instance",
    "/admin/setup/sign-up",
    "/admin/setup/sign-in",
    "/admin/integrations",
    "/admin/mail/anything/below",
    "/api/admin",
    "/api/admin/settings",
    "/api/admin/settings/x",
  ])("treats %s as an admin path", (path) => {
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    "/admin/",
    "/admin//setup",
    "//admin",
    "/%61dmin",
    "/admin%2Fsetup",
    "/api/%61dmin/settings",
    "/api//admin/settings",
    "/admin/../admin",
    "/./admin",
    "/api/admin/",
  ])("treats the spelling %s as an admin path too", (path) => {
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/projects",
    "/administrator",
    "/admins",
    "/adminx/setup",
    "/api",
    "/api/administrator",
    "/api/auth/admin",
    "/runs/admin",
    "/login",
    // Routes are case sensitive: these are no pages at all.
    "/Admin",
    "/%41dmin",
  ])("does not treat %s as an admin path", (path) => {
    expect(isAdminPath(path)).toBe(false);
  });

  it("treats a path that cannot be decoded as an admin path, because it cannot be told apart", () => {
    expect(isAdminPath("/admin%zz")).toBe(true);
    expect(isAdminPath("/%E0%A4%A")).toBe(true);
  });
});

describe("where a portal path is served", () => {
  it.each([
    ["/admin", "/instance-portal"],
    ["/admin/setup", "/instance-portal/setup"],
    ["/admin/setup/instance", "/instance-portal/setup/instance"],
    ["/admin/setup/sign-up", "/instance-portal/setup/sign-up"],
    ["/admin/setup/sign-in", "/instance-portal/setup/sign-in"],
    ["/admin/mail/anything/below", "/instance-portal/mail/anything/below"],
    ["/api/admin/settings", "/api/instance-portal/settings"],
    ["/%61dmin/setup", "/instance-portal/setup"],
    ["/admin/", "/instance-portal"],
    ["//admin//setup", "/instance-portal/setup"],
    ["/admin/../admin", "/instance-portal"],
  ])("serves %s from %s", (path, target) => {
    expect(portalRewriteTarget(path)).toBe(target);
  });

  it.each([
    "/",
    "/projects",
    "/administrator",
    "/api/health",
    "/admin%zz",
    "/Admin",
  ])("serves nothing for %s", (path) => {
    expect(portalRewriteTarget(path)).toBeNull();
  });

  it.each([
    "/instance-portal",
    "/instance-portal/setup",
    "/api/instance-portal/settings",
    "/%69nstance-portal",
    "//instance-portal",
  ])("knows %s as an address of the files of the portal", (path) => {
    expect(isInternalPortalPath(path)).toBe(true);
  });

  it.each(["/", "/admin", "/instance-portals", "/api/instance", "/projects"])(
    "does not know %s as one",
    (path) => {
      expect(isInternalPortalPath(path)).toBe(false);
    },
  );
});
