// SPDX-License-Identifier: Apache-2.0

// The privacy search of the catalog journey (#435): everything a member of a managed workspace can read is collected as
// named texts and searched for what only the operator may know: every model id of the catalog (and the parts of it),
// every provider, the operator's key and the own key of another workspace. A needle is looked for in every form a page
// or an answer could carry it: as written, in any letter case, percent-encoded, JSON- or unicode-escaped, as HTML
// entities and as base64 at the three alignments. The search returns the places it found something instead of stopping
// at the first, so a failure lists every surface that leaks.
//
// A clean answer is only worth something when the search read what it says it read. So every collector here checks that
// the person is signed in (an answer that redirects to the login page, or a page that is not the one asked for, fails
// the run instead of "finding nothing"), and `member-scan-proof.ts` plants leaks of realistic shapes in texts the search
// must reject.
import {
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

/** A text a person can read, with the name of the place it came from. */
export type Surface = { name: string; text: string };

/** Something no member may read, and what to call it in a failure. `needle` is lower case: matching ignores case. */
export type Forbidden = { label: string; needle: string };

/** The shortest part of a value that is searched for alone: shorter ones match ordinary words. */
const SHORTEST_PART = 5;

function base64Forms(value: string): string[] {
  const forms: string[] = [];
  // The three alignments of the bytes of `value` inside a longer text. The characters that mix in the bytes before and
  // after it are cut off, what is left is the same wherever the value stands.
  for (const [pad, skip] of [
    ["", 0],
    ["a", 2],
    ["ab", 3],
  ] as const) {
    const encoded = Buffer.from(pad + value)
      .toString("base64")
      .replace(/=+$/, "");
    const part = encoded.slice(skip, encoded.length - 2);
    if (part.length < 8) continue;
    forms.push(part, part.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return forms;
}

/** Every form in which a text can carry `value`. */
export function formsOf(value: string): string[] {
  const forms = new Set<string>([
    value,
    encodeURIComponent(value),
    encodeURIComponent(encodeURIComponent(value)),
    value.replace(/\//g, "\\/"),
    value.replace(/\//g, "\\u002f").replace(/:/g, "\\u003a"),
    value.replace(/\//g, "&#x2F;").replace(/:/g, "&#58;"),
    value.replace(/\//g, "&#47;").replace(/:/g, "&colon;"),
    ...base64Forms(value),
  ]);
  return [...forms];
}

/** The parts of a model id that name it: the whole, without the variant after ":", the maker and the model. */
function partsOfModelId(id: string): string[] {
  const withoutVariant = id.split(":")[0] ?? id;
  const [maker = "", ...path] = withoutVariant.split("/");
  return [
    ...new Set([id, withoutVariant, maker, ...path, path.join("/")]),
  ].filter((part) => part.length >= SHORTEST_PART);
}

function forbiddenOf(label: string, value: string): Forbidden[] {
  return formsOf(value).map((form) => ({
    label,
    needle: form.toLowerCase(),
  }));
}

export type ForbiddenOptions = {
  modelIds: readonly string[];
  providerIds: readonly string[];
  providerLabels: readonly string[];
  /** Keys: the whole, all but the last four characters, and the start of it. */
  keys: ReadonlyArray<{ label: string; value: string }>;
  /** Anything else, searched as it is written: the name of a draft entry, say. */
  names?: ReadonlyArray<{ label: string; value: string }>;
  /** The start of every key of a provider (`sk-or-v1-`): a key of any account. */
  keyShapes?: readonly string[];
};

/** What a member of a managed workspace may never read, built from the catalog the journey keeps and the portal lists. */
export function forbiddenFor(options: ForbiddenOptions): Forbidden[] {
  const forbidden: Forbidden[] = [];
  for (const id of options.modelIds)
    for (const part of partsOfModelId(id))
      forbidden.push(...forbiddenOf(`the model ${part} (${id})`, part));
  for (const provider of [...options.providerIds, ...options.providerLabels])
    forbidden.push(...forbiddenOf(`the provider ${provider}`, provider));
  for (const key of options.keys) {
    forbidden.push(...forbiddenOf(key.label, key.value));
    forbidden.push(
      ...forbiddenOf(
        `${key.label} without its last four characters`,
        key.value.slice(0, -4),
      ),
    );
    forbidden.push(
      ...forbiddenOf(`the start of ${key.label}`, key.value.slice(0, 12)),
    );
  }
  for (const name of options.names ?? [])
    forbidden.push(...forbiddenOf(name.label, name.value));
  for (const shape of options.keyShapes ?? [])
    forbidden.push(...forbiddenOf(`a key of a provider (${shape}…)`, shape));
  return forbidden;
}

/** One line for each (surface, thing) pair that matches. Empty when nothing leaks. */
export function findLeaks(
  surfaces: readonly Surface[],
  forbidden: readonly Forbidden[],
): string[] {
  const found = new Set<string>();
  for (const { name, text } of surfaces) {
    const lower = text.toLowerCase();
    for (const item of forbidden) {
      const at = lower.indexOf(item.needle);
      if (at < 0) continue;
      const place = text
        .slice(Math.max(0, at - 50), at + item.needle.length + 50)
        .replace(/\s+/g, " ");
      found.add(`${name} holds ${item.label}: …${place}…`);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------------------------------------------------
// Collecting: what a person reads, with proof that the collector read it as that person.

export type ReadOptions = {
  headers?: Record<string, string>;
  /** The answer must hold this (a title, a name only that page has). */
  marker?: string | RegExp;
  /**
   * `ok`: a 200 (after the redirects the app itself sends). `refused`: a 4xx, the answer of a path or a choice the
   * person may not use. `any`: whatever the app answers, the text is read all the same (a prefetch the app does not
   * serve says so with a 404). A 5xx and a redirect to the login page fail in every case.
   */
  status?: "ok" | "refused" | "any";
  label?: string;
};

function holds(text: string, marker: string | RegExp): boolean {
  return typeof marker === "string" ? text.includes(marker) : marker.test(text);
}

/**
 * Reads a path with the session of the page (no browser involved), follows the redirects of the app by hand so that each
 * hop is a surface of its own, and checks the person is who the journey says they are: no redirect to the login page, a
 * status as expected, the marker of the page in the answer.
 */
export async function readAs(
  page: Page,
  path: string,
  options: ReadOptions = {},
): Promise<{ status: number; text: string; surfaces: Surface[] }> {
  const surfaces: Surface[] = [];
  const label = options.label ?? path;
  let next = path;
  for (let hop = 0; hop < 4; hop++) {
    const response = await page.request.get(next, {
      headers: options.headers ?? {},
      maxRedirects: 0,
    });
    const text = await response.text();
    const status = response.status();
    surfaces.push({
      name: hop === 0 ? label : `${label} (after ${String(hop)} redirect)`,
      text,
    });
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"] ?? "";
      const target = new URL(location, response.url());
      expect(
        target.pathname,
        `${label} sent the person to the login page`,
      ).not.toMatch(/^\/(login|sign-up)/);
      next = `${target.pathname}${target.search}`;
      continue;
    }
    expect(status, `${label} answered ${String(status)}`).toBeLessThan(500);
    const wanted = options.status ?? "ok";
    if (wanted === "ok")
      expect(status, `${label}: ${text.slice(0, 200)}`).toBe(200);
    else if (wanted === "refused")
      expect(status, `${label}: ${text.slice(0, 200)}`).toBeGreaterThanOrEqual(
        400,
      );
    if (options.marker !== undefined)
      expect(
        holds(text, options.marker),
        `${label} does not hold ${String(options.marker)}: it is not the page asked for`,
      ).toBe(true);
    return { status, text, surfaces };
  }
  throw new Error(`${label} redirects more than three times.`);
}

/** The session of the page is a live one: the workspace answers it as the person who is signed in. */
export async function expectSignedIn(page: Page, slug: string): Promise<void> {
  const answer = await readAs(page, `/api/w/${slug}/runs`, {
    marker: '"runs"',
    label: `the session check of /api/w/${slug}/runs`,
  });
  expect(() => JSON.parse(answer.text) as unknown).not.toThrow();
}

/**
 * What the browser shows of a page once it is hydrated: the DOM and the visible text (`innerText` honours
 * `text-transform`, so what CSS upper-cases is searched as it is read). A real navigation, so the browser's own
 * requests are those a recorder sees.
 */
export async function browse(
  page: Page,
  path: string,
  options: { title?: string } = {},
): Promise<Surface[]> {
  await page.goto(path);
  await expect(page.locator("main, [role=main], body").first()).toBeVisible();
  await page.waitForFunction(() =>
    Object.keys(document).some((key) => key.startsWith("__reactContainer")),
  );
  expect(page.url(), `${path} ended on the login page`).not.toMatch(
    /\/(login|sign-up)(\?|$)/,
  );
  // A page the app sends the person away from (the page for people without a workspace) has the title of where they land.
  if (options.title !== undefined && new URL(page.url()).pathname === path)
    await expect(page).toHaveTitle(new RegExp(options.title));
  // What the page loads once it runs (the runs, the choice) has arrived: the requests it made stop growing.
  let requests = -1;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(
          () => performance.getEntriesByType("resource").length,
        );
        const settled = now === requests;
        requests = now;
        return settled;
      },
      { timeout: 10_000, intervals: [300] },
    )
    .toBe(true);
  return [
    { name: `${path} (DOM)`, text: await page.content() },
    { name: `${path} (text)`, text: await page.locator("body").innerText() },
  ];
}

export type NetworkRecorder = {
  /** The requests (method, path and query) the browser got an answer for, in order. */
  seen(): string[];
  /** Stops recording; every answer is a surface, and a request that failed is named in `failures`. */
  stop(): Promise<{ surfaces: Surface[]; failures: string[] }>;
};

const BINARY = /^(image|font|audio|video)\/|octet-stream/;

/**
 * Records the body of every answer the browsers of a context receive from now on: the pages, the Next.js payloads of
 * client navigations and prefetches, the data routes, the answers to a save. It sits in the route of the context, so it
 * asks the server itself, keeps the body and hands it to the browser: nothing depends on the browser still holding a
 * body once the page has moved on. The scripts and styles of the app (`/_next/static/`) are code, not data, and pass
 * through. A request that fails is a failure of the run, never a quiet gap.
 */
export async function recordNetwork(
  context: BrowserContext,
): Promise<NetworkRecorder> {
  const surfaces: Surface[] = [];
  const failures: string[] = [];
  const seen: string[] = [];
  const inFlight = new Set<Promise<void>>();
  const handler = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/_next/image")
    )
      return route.continue();
    const work = (async () => {
      const label = `${request.method()} ${url.pathname}${url.search}`;
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
      } catch (error) {
        failures.push(`${label}: ${String(error).slice(0, 200)}`);
        await route.abort().catch(() => undefined);
        return;
      }
      const body = await response.body();
      seen.push(label);
      if (!BINARY.test(response.headers()["content-type"] ?? ""))
        surfaces.push({
          name: `a response to ${label} (${String(response.status())})`,
          text: body.toString("utf8"),
        });
      // The browser may have given up on the request meanwhile; the body is recorded either way.
      await route.fulfill({ response, body }).catch(() => undefined);
    })();
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  };
  await context.route("**/*", handler);
  return {
    seen: () => [...seen],
    async stop() {
      await Promise.allSettled([...inFlight]);
      await context.unroute("**/*", handler);
      await Promise.allSettled([...inFlight]);
      return { surfaces: [...surfaces], failures: [...failures] };
    },
  };
}
