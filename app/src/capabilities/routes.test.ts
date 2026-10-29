// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "./capability.ts";
import {
  capabilityOfPath,
  classOfRoute,
  isAbsentPath,
  ROUTE_CLASSES,
} from "./routes.ts";

const APP_DIR = join(import.meta.dirname, "..", "app");

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

/** The route of a `page.tsx` or `route.ts` below src/app: `(group)` folders do not count, `/` for the root. */
function routeOf(file: string): string | undefined {
  const parts = relative(APP_DIR, file).split(sep);
  const leaf = parts.pop();
  if (leaf !== "page.tsx" && leaf !== "route.ts") return undefined;
  const segments = parts.filter((part) => !/^\(.*\)$/.test(part));
  return `/${segments.join("/")}`;
}

function routesOfApp(): string[] {
  return filesBelow(APP_DIR)
    .map(routeOf)
    .filter((route): route is string => route !== undefined);
}

describe("the route classification", () => {
  // #731-T07
  it("covers every page and route of the app", () => {
    const routes = routesOfApp();
    expect(routes.length).toBeGreaterThan(100);
    const unclassified = routes.filter(
      (route) => classOfRoute(route) === undefined,
    );
    expect(
      unclassified,
      "add the route to ROUTE_CLASSES in src/capabilities/routes.ts",
    ).toEqual([]);
  });

  // #731-T07
  it("fails for a route nobody classified (fixture)", () => {
    expect(classOfRoute("/a-new-feature")).toBeUndefined();
    expect(classOfRoute("/api/w/[workspace]/a-new-feature")).toBe("core");
    expect(classOfRoute("/new-top-level/[id]")).toBeUndefined();
  });

  it("has no pattern that covers no route of the app (no stale entry)", () => {
    const routes = routesOfApp();
    const stale = ROUTE_CLASSES.filter(
      (entry) =>
        !routes.some((route) => {
          const own = classOfRoute(route);
          return (
            own !== undefined &&
            (route === entry.route || route.startsWith(`${entry.route}/`))
          );
        }),
    ).map((entry) => entry.route);
    expect(stale).toEqual([]);
  });

  it("puts each billing and review route in its capability, the specific pattern winning inside a core one", () => {
    const expected: Record<string, string> = {
      "/w/[workspace]/settings/billing": "billing",
      "/w/[workspace]/settings": "core",
      "/w/[workspace]/settings/llm": "core",
      "/w/[workspace]/settings/review-defaults": "review",
      "/w/[workspace]/projects/[repositoryId]": "review",
      "/w/[workspace]/connections": "core",
      "/api/w/[workspace]/billing/top-ups/[id]/check": "billing",
      "/api/w/[workspace]/runs/[id]": "review",
      "/api/w/[workspace]/members/[userId]": "core",
      "/api/billing/webhook": "billing",
      "/api/webhooks/github-app": "review",
      "/api/runners/v1/claim": "review",
      "/api/workers/v1/jobs/[id]/result": "review",
      "/api/internal/repository-sync": "review",
      "/api/internal/dispatch-sweep": "core",
      "/instance-portal/billing/reviews": "billing",
      "/api/instance-portal/billing/webhook-endpoint": "billing",
      "/instance-portal/runs/[id]": "review",
      "/instance-portal/llm": "core",
      "/projects/[[...rest]]": "review",
      "/api/health": "core",
    };
    for (const [route, expectedClass] of Object.entries(expected))
      expect(classOfRoute(route), route).toBe(expectedClass);
  });
});

describe("capabilityOfPath and isAbsentPath", () => {
  const factory = createCapabilitySet(["review", "dynamic-review"]);
  const nothing = createCapabilitySet([]);

  it("read a request path the way the router does, the admin addresses as the files that serve them", () => {
    expect(capabilityOfPath("/w/acme/settings/billing")).toBe("billing");
    expect(capabilityOfPath("/w/acme/settings/billing/")).toBe("billing");
    expect(capabilityOfPath("/w/acme//settings/%62illing")).toBe("billing");
    expect(capabilityOfPath("/w/acme/./projects/../settings/billing")).toBe(
      "billing",
    );
    expect(capabilityOfPath("/admin/billing")).toBe("billing");
    expect(capabilityOfPath("/api/admin/billing/reviews")).toBe("billing");
    expect(capabilityOfPath("/admin/runs/7")).toBe("review");
    expect(capabilityOfPath("/admin/setup/instance")).toBeUndefined();
    expect(capabilityOfPath("/projects")).toBe("review");
    expect(capabilityOfPath("/projects/12/x")).toBe("review");
    // not the same word
    expect(capabilityOfPath("/projects-archive")).toBeUndefined();
    expect(capabilityOfPath("/api/billing-other")).toBeUndefined();
    // cannot be read: no page either
    expect(capabilityOfPath("/w/%E0%A4%A/projects")).toBeUndefined();
  });

  // #731-T03
  it("find the billing paths absent in the factory set, pages and APIs", () => {
    for (const path of [
      "/api/billing/webhook",
      "/w/acme/settings/billing",
      "/api/w/acme/billing/top-ups",
      "/api/w/acme/billing/journal",
      "/api/w/acme/llm-key-mode",
      "/admin/billing",
      "/admin/billing/reviews",
      "/api/admin/billing",
      "/api/admin/billing/workspaces/abc/credit",
    ])
      expect(isAbsentPath(path, factory), path).toBe(true);
    for (const path of [
      "/w/acme/projects",
      "/w/acme/settings",
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/admin/setup/instance",
      "/api/health",
    ])
      expect(isAbsentPath(path, factory), path).toBe(false);
  });

  // #731-T04
  it("find the review paths absent in a set without review, and the health check never", () => {
    for (const path of [
      "/api/webhooks/github-app",
      "/api/runners/v1/claim",
      "/api/workers/v1/jobs/1/result",
      "/w/acme/projects",
      "/w/acme/runs/3",
      "/api/w/acme/runs",
      "/api/w/acme/repositories/5/reviews",
      "/projects",
      "/runs/4",
      "/api/internal/repository-sync",
    ])
      expect(isAbsentPath(path, nothing), path).toBe(true);
    for (const path of [
      "/api/health",
      "/login",
      "/w/acme/members",
      "/api/internal/dispatch-sweep",
    ])
      expect(isAbsentPath(path, nothing), path).toBe(false);
  });
});
