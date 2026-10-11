// Pins down which request paths belong to the admin portal. The rule has to hold for every spelling
// that Next.js would route to an admin page or route: a path the proxy did not recognize as an admin
// path would reach the portal without the 404 for people who are not admins.
import { describe, expect, it } from "vitest";
import { isAdminPath } from "./paths.ts";

describe("which paths belong to the admin portal", () => {
  it.each([
    "/admin",
    "/admin/setup",
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
