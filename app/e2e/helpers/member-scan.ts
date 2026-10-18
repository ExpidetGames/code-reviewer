// SPDX-License-Identifier: Apache-2.0

// The privacy search of the catalog journey (#435): everything a member of a managed workspace can read is collected as
// named texts and searched for what only the operator may know, every model id of the catalog and every provider among
// it. The search returns the places it found something instead of stopping at the first, so a failure lists every
// surface that leaks. It is not vacuous: `CONTROLS` are texts that must be found, and the journey runs them first.
import { expect, type Page } from "@playwright/test";

/** A text a person can read, with the name of the place it came from. */
export type Surface = { name: string; text: string };

/** Something no member may read, and what to call it in a failure. */
export type Forbidden = {
  label: string;
  needle: string;
  /** Provider names are matched in any case ("OpenRouter", "openrouter"); ids are matched as written. */
  anyCase?: boolean;
};

/** Where `needle` is in `text`, with what is around it, or "" when it is not there. */
function around(text: string, needle: string, anyCase: boolean): string {
  const at = anyCase
    ? text.toLowerCase().indexOf(needle.toLowerCase())
    : text.indexOf(needle);
  return at < 0 ? "" : text.slice(Math.max(0, at - 60), at + 60);
}

/** One line for each (surface, needle) pair that matches. Empty when nothing leaks. */
export function findLeaks(
  surfaces: readonly Surface[],
  forbidden: readonly Forbidden[],
): string[] {
  const found: string[] = [];
  for (const { name, text } of surfaces)
    for (const item of forbidden) {
      const place = around(text, item.needle, item.anyCase === true);
      if (place !== "")
        found.push(
          `${name} holds ${item.label}: …${place.replace(/\s+/g, " ")}…`,
        );
    }
  return found;
}

/**
 * What a member of a managed workspace may never read, built from the catalog the journey itself keeps: every model id
 * (the id, its name without the vendor and its vendor), the provider and the operator's key. `modelIds` are those the
 * admin portal lists, so an entry the journey did not know about is searched for too.
 */
export function forbiddenForMembers(options: {
  modelIds: readonly string[];
  providerIds: readonly string[];
  providerLabels: readonly string[];
  secrets: ReadonlyArray<{ label: string; value: string }>;
}): Forbidden[] {
  const forbidden: Forbidden[] = [];
  for (const id of options.modelIds) {
    forbidden.push({ label: `the model id ${id}`, needle: id });
    const [vendor, name] = id.split("/");
    if (name !== undefined && vendor !== undefined) {
      forbidden.push({ label: `the model name ${name} (${id})`, needle: name });
      forbidden.push({ label: `the vendor ${vendor} (${id})`, needle: vendor });
    }
  }
  for (const provider of [...options.providerIds, ...options.providerLabels])
    forbidden.push({
      label: `the provider ${provider}`,
      needle: provider,
      anyCase: true,
    });
  for (const secret of options.secrets) {
    forbidden.push({ label: secret.label, needle: secret.value });
    // A key cut short is as good as a key to anyone who searches for it.
    forbidden.push({
      label: `${secret.label} without its last four characters`,
      needle: secret.value.slice(0, -4),
    });
  }
  return forbidden;
}

/**
 * Texts that must fail the search, one for each kind of thing it looks for, and one that must pass. The journey runs them
 * before it trusts a clean answer.
 */
export function controlsFor(
  forbidden: readonly Forbidden[],
): Array<{ name: string; text: string; leaks: boolean }> {
  const controls = forbidden.map((item) => ({
    name: item.label,
    text: `a page that says ${item.anyCase === true ? item.needle.toUpperCase() : item.needle} once`,
    leaks: true,
  }));
  controls.push({
    name: "a page with nothing in it",
    text: "Small, Big, Quality, Not included in your plan",
    leaks: false,
  });
  return controls;
}

/**
 * Collects, with the browser of one person, the pages and the answers of the data routes they can read: the server
 * rendered page, the same page as the Next.js payload a client navigation fetches (the RSC stream), and the JSON
 * answers. Named, so that a failure says where the leak was.
 */
export async function collectViews(
  page: Page,
  slug: string,
): Promise<Surface[]> {
  const surfaces: Surface[] = [];
  const read = async (
    path: string,
    headers: Record<string, string> = {},
    label = path,
  ): Promise<string> => {
    const response = await page.request.get(path, { headers });
    expect(response.status(), label).toBe(200);
    const text = await response.text();
    surfaces.push({ name: label, text });
    return text;
  };
  const readPage = async (path: string): Promise<string> => {
    const html = await read(path);
    await read(path, { RSC: "1" }, `${path} (RSC payload)`);
    return html;
  };
  for (const path of [
    `/w/${slug}`,
    `/w/${slug}/settings`,
    `/w/${slug}/settings/review-defaults`,
    `/w/${slug}/settings/llm`,
    `/w/${slug}/settings/plan`,
    `/w/${slug}/settings/advanced`,
    `/w/${slug}/projects`,
    `/w/${slug}/connections`,
    `/w/${slug}/members`,
    `/w/${slug}/runs`,
  ])
    await readPage(path);
  for (const path of [
    `/api/w/${slug}/plan`,
    `/api/w/${slug}/llm-key`,
    `/api/w/${slug}/runs`,
    `/api/w/${slug}/review-settings`,
  ])
    await read(path);

  // The project of the repository, found by the link on the Projects page, and every run.
  const projects =
    surfaces.find(({ name }) => name === `/w/${slug}/projects`)?.text ?? "";
  const repositoryId = new RegExp(`/w/${slug}/projects/([^"/?#]+)`).exec(
    projects,
  )?.[1];
  if (repositoryId === undefined)
    throw new Error("The Projects page has no link to the project.");
  await readPage(`/w/${slug}/projects/${repositoryId}`);
  await readPage(`/w/${slug}/projects/${repositoryId}/review`);
  await read(`/api/w/${slug}/repositories/${repositoryId}/project/settings`);
  await read(`/api/w/${slug}/repositories/${repositoryId}/pull-requests`);
  const runs = JSON.parse(
    surfaces.find(({ name }) => name === `/api/w/${slug}/runs`)?.text ?? "{}",
  ) as { runs?: Array<{ id: string }> };
  for (const run of runs.runs ?? []) {
    await readPage(`/w/${slug}/runs/${run.id}`);
    await read(`/api/w/${slug}/runs/${run.id}`);
  }
  return surfaces;
}

/**
 * What the browser shows of the pages that load and poll their data once they are hydrated: the DOM and the visible
 * text, for the pages that carry the choice and the runs.
 */
export async function renderedViews(
  page: Page,
  slug: string,
  runId: string,
): Promise<Surface[]> {
  const surfaces: Surface[] = [];
  const take = async (name: string, path: string) => {
    await page.goto(path);
    await expect(page.locator("main, [role=main], body").first()).toBeVisible();
    // Hydrated: React has taken the document over, so what is read next is what the browser shows.
    await page.waitForFunction(() =>
      Object.keys(document).some((key) => key.startsWith("__reactContainer")),
    );
    surfaces.push({ name: `${name} (DOM)`, text: await page.content() });
    surfaces.push({
      name: `${name} (text)`,
      text: await page.locator("body").innerText(),
    });
  };
  await take("the Runs list", `/w/${slug}/runs`);
  await take("a run", `/w/${slug}/runs/${runId}`);
  await take("the plan page", `/w/${slug}/settings/plan`);
  return surfaces;
}

/** An answer whose body the browser never handed over (the page moved on before it was complete). */
export type Unread = { method: string; path: string; contentType: string };

/**
 * Records the body of every answer the browser of one person receives, from the first request to the call of `stop`:
 * the pages, the Next.js payloads of client navigations, and the data routes. The scripts and styles of the app are
 * code, not data, and are left out. A body that does not arrive within `READ_LIMIT_MS` (the browser drops the body of
 * an answer whose page navigated away) is not waited for, and is returned as `unread`, so that the journey can say
 * which kinds of answer it did not see.
 */
export function recordNetwork(page: Page): {
  stop(): Promise<{ surfaces: Surface[]; unread: Unread[] }>;
} {
  const READ_LIMIT_MS = 5_000;
  const pending: Array<Promise<Surface | Unread | null>> = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/_next/static/")) return;
    if (url.pathname.startsWith("/_next/image")) return;
    const method = response.request().method();
    const unread: Unread = {
      method,
      path: `${url.pathname}${url.search}`,
      contentType: response.headers()["content-type"] ?? "",
    };
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<Unread>((resolve) => {
      timer = setTimeout(() => resolve(unread), READ_LIMIT_MS);
    });
    pending.push(
      Promise.race([
        response.text().then((text) => ({
          name: `a response to ${method} ${unread.path}`,
          text,
        })),
        gaveUp,
      ])
        // A redirect or an aborted request has no body to read.
        .catch(() => null)
        .finally(() => clearTimeout(timer)),
    );
  });
  return {
    async stop() {
      const all = await Promise.all(pending);
      const surfaces: Surface[] = [];
      const unread: Unread[] = [];
      for (const item of all) {
        if (item === null) continue;
        if ("text" in item) surfaces.push(item);
        else unread.push(item);
      }
      return { surfaces, unread };
    },
  };
}
