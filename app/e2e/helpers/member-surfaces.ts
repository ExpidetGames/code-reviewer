// SPDX-License-Identifier: LicenseRef-Proprietary

// Every surface a member of a workspace can read, collected the two ways a person meets them (#435): the routes read with
// the person's session (the page as the server renders it, the same page as the Next.js payload a navigation fetches,
// its prefetch variant, and the data routes) and the pages opened in the person's browser. The routes come from the app
// router itself (`member-routes.ts`), so a route added to the app is read without a line here. Each read checks that the
// person is signed in and that the page is the one asked for (`member-scan.ts`).
import { expect, type Page } from "@playwright/test";
import {
  addressesOf,
  memberRoutes,
  type MemberRoute,
  type RouteValues,
} from "./member-routes";
import {
  browse,
  expectSignedIn,
  readAs,
  type NetworkRecorder,
  type Surface,
} from "./member-scan";

/** What a page must hold to be the page asked for. */
function markerOf(route: MemberRoute, slug: string): string | undefined {
  if (route.title !== undefined) return route.title;
  return route.pattern.startsWith("/w/") ? `/w/${slug}` : undefined;
}

/** The header sets that make Next.js answer with a payload instead of a document. */
const PAYLOADS: Array<{
  name: string;
  headers: Record<string, string>;
  status: "ok" | "any";
}> = [
  { name: "RSC payload", headers: { RSC: "1" }, status: "ok" },
  // A prefetch the app does not serve for a page is a 404 and says so; what it does serve is read like the rest.
  {
    name: "RSC prefetch",
    headers: { RSC: "1", "Next-Router-Prefetch": "1" },
    status: "any",
  },
  {
    name: "RSC segment prefetch",
    headers: {
      RSC: "1",
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "/_tree",
    },
    status: "any",
  },
];

export type WorkspaceIds = { repositoryId: string; runIds: string[] };

/** The project and the runs of the workspace, as the person reads them (the Projects page and the Runs API). */
export async function idsOf(page: Page, slug: string): Promise<WorkspaceIds> {
  const projects = await readAs(page, `/w/${slug}/projects`, {
    marker: "Projects",
  });
  const repositoryId = new RegExp(`/w/${slug}/projects/([0-9a-f-]{20,})`).exec(
    projects.text,
  )?.[1];
  if (repositoryId === undefined)
    throw new Error("The Projects page has no link to the project.");
  const runs = await readAs(page, `/api/w/${slug}/runs`, {
    marker: '"runs"',
  });
  const list = JSON.parse(runs.text) as { runs: Array<{ id: string }> };
  return { repositoryId, runIds: list.runs.map((run) => run.id) };
}

/** The addresses the person reads, as pages and as data routes. */
export function addressesFor(slug: string, ids: WorkspaceIds) {
  const values: RouteValues = { slug, ...ids };
  const routes = memberRoutes();
  return routes.flatMap((route) =>
    addressesOf(route, values).map((address) => ({ route, ...address })),
  );
}

/**
 * Reads every route of the member with the session of `page`: no browser involved. Returns the surfaces and how many
 * data routes answered 200 (a floor the journey asserts, so a collector that reads nothing cannot pass).
 */
export async function readRoutes(
  page: Page,
  slug: string,
  ids: WorkspaceIds,
): Promise<{ surfaces: Surface[]; apiOk: number; pages: number }> {
  await expectSignedIn(page, slug);
  const surfaces: Surface[] = [];
  let apiOk = 0;
  let pages = 0;
  for (const { route, path, refused } of addressesFor(slug, ids)) {
    if (route.kind === "page") {
      pages++;
      const marker = markerOf(route, slug);
      // A page that does not exist (the billing page while billing is off, #505) answers like the page of a missing path: Next.js
      // streams its 404 UI inside a 200 when the page's data sits behind the layout's Suspense, so only a data route is held to a 4xx.
      const html = await readAs(page, path, {
        ...(marker === undefined || refused ? {} : { marker }),
        status: refused ? "any" : "ok",
      });
      surfaces.push(...html.surfaces);
      for (const payload of PAYLOADS) {
        const read = await readAs(page, path, {
          headers: payload.headers,
          status: refused ? "any" : payload.status,
          ...(path.startsWith("/w/") && payload.status === "ok" && !refused
            ? { marker: slug }
            : {}),
          label: `${path} (${payload.name})`,
        });
        surfaces.push(...read.surfaces);
      }
      continue;
    }
    const read = await readAs(page, path, {
      status: refused ? "refused" : "ok",
      label: `GET ${path}`,
    });
    if (read.status === 200) apiOk++;
    surfaces.push(...read.surfaces);
  }
  // Pages and answers that a mistaken address gets are the ones that tend to echo what was asked.
  for (const path of [
    `/w/${slug}/runs/no-such-run`,
    `/w/${slug}/projects/no-such-project`,
    `/api/w/${slug}/runs/no-such-run`,
    `/api/w/${slug}/repositories/no-such-project/project/settings`,
  ]) {
    const read = await readAs(page, path, { status: "any" });
    surfaces.push(...read.surfaces);
  }
  await expectSignedIn(page, slug);
  return { surfaces, apiOk, pages };
}

/**
 * Opens every page of the member in the browser of `page`, hydrated, and takes the DOM and the visible text of each.
 * Returns the paths opened. What the browser asks of the app on the way is what a recorder on its context keeps.
 */
export async function browseRoutes(
  page: Page,
  slug: string,
  ids: WorkspaceIds,
): Promise<{ surfaces: Surface[]; visited: string[] }> {
  const surfaces: Surface[] = [];
  const visited: string[] = [];
  for (const { route, path, refused } of addressesFor(slug, ids)) {
    if (route.kind !== "page" || refused) continue;
    surfaces.push(
      ...(await browse(
        page,
        path,
        route.title === undefined ? {} : { title: route.title },
      )),
    );
    visited.push(path);
  }
  return { surfaces, visited };
}

/** The recorder saw the browser ask for every page that was opened. */
export function expectRecorded(
  recorder: NetworkRecorder,
  visited: readonly string[],
  who: string,
): void {
  const seen = recorder.seen();
  for (const path of visited)
    expect(
      seen.some(
        (entry) => entry === `GET ${path}` || entry.startsWith(`GET ${path}?`),
      ),
      `${who}: the recorder did not see the browser open ${path}`,
    ).toBe(true);
}
