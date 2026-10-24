// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The catalog page (#554): the models with their state, price status and warnings, the filters and the count of new
// models, the paging of a long list, the empty catalog, and what the page does with text that came from models.dev: markup
// is text, a long name is cut where it is shown, and nothing from the catalog is set as HTML.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AT,
  book,
  list,
  model,
  provider,
  staleModel,
  staleModelBetween,
} from "../../test-support/catalog-models-fixtures.ts";
import { findHtmlSinks } from "../../test-support/html-sinks.ts";
import { AdminCatalogContent } from "./catalog-content.tsx";
import { PAGE_SIZE, type CatalogQuery } from "./query.ts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

const QUERY: CatalogQuery = { page: 1 };

/** The row of the model with this id. */
function rowOf(modelId: string) {
  const row = screen.getByText(modelId).closest("tr");
  if (row === null) throw new Error(`no row for ${modelId}`);
  return within(row);
}

function renderPage(
  models = [model()],
  options: {
    query?: CatalogQuery;
    total?: number;
    providers?: ReturnType<typeof provider>[];
    newCount?: number;
    fetchEnabled?: boolean;
  } = {},
) {
  return render(
    <AdminCatalogContent
      list={list(models, {
        ...(options.total === undefined ? {} : { total: options.total }),
        ...(options.newCount === undefined
          ? {}
          : { newCount: options.newCount }),
      })}
      providers={{
        providers: options.providers ?? [provider()],
        fetchEnabled: options.fetchEnabled ?? true,
      }}
      query={options.query ?? QUERY}
    />,
  );
}

describe("the models of the catalog", () => {
  // #554-T01
  it("lists a model with its id, its state, its price status and its provider", () => {
    renderPage([model({ isNew: true })]);

    const row = screen.getByRole("row", { name: /DeepSeek V4 Pro/ });
    expect(within(row).getByText("deepseek-v4-pro")).toBeTruthy();
    expect(within(row).getByText("New")).toBeTruthy();
    expect(within(row).getByText("Unconfirmed")).toBeTruthy();
    expect(within(row).getByText("DeepSeek")).toBeTruthy();
    expect(
      within(row).getByText(/Input \$0\.60 · Output \$1\.20/),
    ).toBeTruthy();
    expect(
      within(row).getByText(
        /Not usable on the managed key: The model is not enabled/,
      ),
    ).toBeTruthy();
  });

  // #554-T01
  it("says new, enabled, disabled and not decided in words", () => {
    renderPage([
      model({ modelId: "model-a", name: "A", isNew: true }),
      model({
        modelId: "model-b",
        name: "B",
        enabled: true,
        managed: { selectable: true, reason: null },
      }),
      model({ modelId: "model-c", name: "C", enabled: false }),
      model({ modelId: "model-d", name: "D" }),
    ]);

    expect(rowOf("model-a").getByText("New")).toBeTruthy();
    expect(rowOf("model-b").getByText("Enabled")).toBeTruthy();
    expect(rowOf("model-c").getByText("Disabled")).toBeTruthy();
    expect(rowOf("model-d").getByText("Not decided")).toBeTruthy();
    expect(
      rowOf("model-b").getByText("Usable on the managed key"),
    ).toBeTruthy();
  });

  // #554-T01
  it("shows each price status and the warnings of a model next to it, with words", () => {
    const unpriced = model({
      modelId: "model-u",
      name: "U",
      upstreamStatus: "deprecated",
      listed: false,
      price: {
        ...model().price,
        status: "unpriced",
        book: null,
        reference: { book: null, hash: "v2:x", sources: null },
        sources: null,
      },
    });
    const alpha = model({
      modelId: "model-al",
      name: "AL",
      upstreamStatus: "alpha",
    });
    const unreadable = model({
      modelId: "model-ur",
      name: "UR",
      price: { ...model().price, warnings: ["confirmation_unreadable"] },
    });
    renderPage([unpriced, alpha, unreadable]);

    const u = rowOf("model-u");
    expect(u.getByText("Unpriced")).toBeTruthy();
    expect(u.getByText("Deprecated")).toBeTruthy();
    expect(u.getByText("Unlisted")).toBeTruthy();
    expect(u.getByText("No price stated")).toBeTruthy();
    expect(rowOf("model-al").getByText("Alpha")).toBeTruthy();
    expect(rowOf("model-ur").getByText("Confirmation unreadable")).toBeTruthy();
  });

  // #554-T05
  it("shows both prices of a stale price: the one that was confirmed and the one now", () => {
    renderPage([staleModel()]);

    const row = within(screen.getByRole("row", { name: /DeepSeek V4 Pro/ }));
    expect(row.getByText("Stale")).toBeTruthy();
    expect(row.getByText(/Input \$0\.50 · Output \$1\.00/)).toBeTruthy();
    expect(row.getByText(/Input \$0\.60 · Output \$1\.20/)).toBeTruthy();
    expect(row.getByText("You confirmed:")).toBeTruthy();
    expect(row.getByText("Now:")).toBeTruthy();
  });

  // #554-T05
  it("says in which fields a stale price differs, even when input and output did not move", () => {
    renderPage([
      staleModelBetween(
        book("500000", "1000000", { cacheRead: "50000" }),
        book("500000", "1000000", { cacheRead: "60000", reasoning: "2000000" }),
      ),
    ]);

    const row = within(screen.getByRole("row", { name: /DeepSeek V4 Pro/ }));
    expect(row.getByText("Differs in: cache read, reasoning")).toBeTruthy();
  });

  // #554-T05
  it("says that no amount differs when a price is stale for another reason", () => {
    const same = book("500000", "1000000", { cacheRead: "50000" });
    renderPage([staleModelBetween(same, { ...same })]);

    const row = within(screen.getByRole("row", { name: /DeepSeek V4 Pro/ }));
    expect(row.getByText(/No amount differs/)).toBeTruthy();
  });

  // #554-T05
  it("says that the catalog states no price now for a stale price that lost its price", () => {
    renderPage([staleModelBetween(book("500000", "1000000"), null)]);

    const row = within(screen.getByRole("row", { name: /DeepSeek V4 Pro/ }));
    expect(row.getByText(/models\.dev states no price now/)).toBeTruthy();
  });

  // #554-T06
  it("marks the models of a provider whose address changed as blocked", () => {
    renderPage([model({ providerUrl: "url_changed" })], {
      providers: [
        provider({
          url: {
            state: "url_changed",
            trustedUrl: "https://api.deepseek.com",
            pendingUrl: "https://api.deepseek.moved.example/v1",
            problem: null,
          },
        }),
      ],
    });

    const row = within(screen.getByRole("row", { name: /DeepSeek V4 Pro/ }));
    expect(row.getByText("Address blocked")).toBeTruthy();
  });
});

describe("what comes from models.dev is text", () => {
  // #554-T07
  it("renders a name with markup as text and runs nothing", () => {
    const hostile =
      '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const { container } = renderPage([
      model({ name: hostile, modelId: "<b>id</b>" }),
    ]);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  // #554-T07
  it("cuts a very long name and id where they are shown, and keeps the whole text as the title", () => {
    const long = "N".repeat(500);
    const longId = "i".repeat(500);
    const { container } = renderPage([model({ name: long, modelId: longId })]);

    const cut = container.querySelectorAll('[data-cut="true"]');
    expect(cut.length).toBeGreaterThanOrEqual(2);
    for (const element of cut) {
      expect(element.textContent?.endsWith("…")).toBe(true);
      expect(element.textContent?.length).toBeLessThanOrEqual(70);
    }
    expect(container.querySelector(`[title="${long}"]`)).not.toBeNull();
    expect(container.querySelector(`[title="${longId}"]`)).not.toBeNull();
  });

  // #554-T07
  it("sets nothing from the catalog as HTML, script or a place to go", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = readdirSync(import.meta.dirname).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
    );

    expect(files).toContain("providers-panel.tsx");
    for (const file of files)
      expect(
        findHtmlSinks(
          readFileSync(join(import.meta.dirname, file), "utf8"),
          file,
        ),
        file,
      ).toEqual([]);
  });
});

describe("finding a model among thousands", () => {
  // #554-T01
  it("shows the count of new models on the link that filters for them", () => {
    renderPage([model({ isNew: true })], { newCount: 7 });

    const link = screen.getByRole("link", { name: /New models/ });
    expect(link.getAttribute("href")).toBe("/admin/catalog?state=new");
    expect(within(link).getByText("7")).toBeTruthy();
  });

  // #554-T01
  it("offers search, provider, price status and state as a form that reads the address, with the current choice selected", () => {
    renderPage([model()], {
      query: {
        provider: "deepseek",
        search: "v4",
        priceStatus: "stale",
        state: "enabled",
        page: 1,
      },
      providers: [provider(), provider({ id: "openai", name: "OpenAI" })],
    });

    const form = screen.getByRole("search", { name: "Filter the catalog" });
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/admin/catalog");
    expect(
      (within(form).getByLabelText("Search") as HTMLInputElement).value,
    ).toBe("v4");
    expect(
      (within(form).getByLabelText("Provider") as HTMLSelectElement).value,
    ).toBe("deepseek");
    expect(
      (within(form).getByLabelText("Price status") as HTMLSelectElement).value,
    ).toBe("stale");
    expect(
      (within(form).getByLabelText("State") as HTMLSelectElement).value,
    ).toBe("enabled");
    expect(
      within(within(form).getByLabelText("Provider"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All providers", "DeepSeek", "OpenAI"]);
    expect(
      screen.getByRole("link", { name: "Clear" }).getAttribute("href"),
    ).toBe("/admin/catalog");
  });

  // #554-T01
  it("pages a long list: where the page is, and the links to the pages before and after", () => {
    const models = Array.from({ length: PAGE_SIZE }, (_, i) =>
      model({ modelId: `m-${String(i)}`, name: `Model ${String(i)}` }),
    );

    renderPage(models, { total: 230, query: { state: "new", page: 2 } });

    expect(screen.getByText("Showing 51–100 of 230 models")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Previous page" }).getAttribute("href"),
    ).toBe("/admin/catalog?state=new");
    expect(
      screen.getByRole("link", { name: "Next page" }).getAttribute("href"),
    ).toBe("/admin/catalog?state=new&page=3");
  });

  // #554-T01
  it("has no next page on the last page and no previous page on the first", () => {
    renderPage([model()], { total: 1 });

    expect(screen.queryByRole("link", { name: "Previous page" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
    expect(screen.getByText("Showing 1–1 of 1 models")).toBeTruthy();
  });

  // #554-T01
  it("says so when no model matches, and when the page is past the end", () => {
    const { unmount } = renderPage([], {
      total: 0,
      query: { search: "zzz", page: 1 },
    });
    expect(screen.getByText("No model matches these filters.")).toBeTruthy();
    unmount();

    renderPage([], { total: 12, query: { page: 9 } });
    expect(
      screen.getByText("This page is past the end of the list."),
    ).toBeTruthy();
  });

  // #554-T01
  it("shows the collapsed state while the catalog is empty: no table, no filters, and the fetch to fill it", () => {
    render(
      <AdminCatalogContent
        list={list([], { fetch: null })}
        providers={{ providers: [], fetchEnabled: true }}
        query={QUERY}
      />,
    );

    expect(
      screen.getByText(
        "The catalog is empty. It is filled by the first fetch.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.getByRole("button", { name: "Fetch now" })).toBeTruthy();
    expect(screen.getByText("No fetch has run yet.")).toBeTruthy();
  });

  // #554-T01
  it("is a page of one h1 with the admin breadcrumb", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "models.dev catalog" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Admin" }).getAttribute("href"),
    ).toBe("/admin");
  });
});

describe("a time that is not a time", () => {
  // #554-T01
  it("shows the first-seen time of a model in UTC", () => {
    renderPage([model()]);

    expect(screen.getByText(/2026-10-20 08:00 UTC/)).toBeTruthy();
    expect(AT).toContain("2026-10-20");
  });
});
