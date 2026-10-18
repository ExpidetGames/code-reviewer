// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the catalog section of the LLM page (#429): empty and collapsed, the table with the retired entries, the form
// with the warning that members see the name, the check of the model, what a refusal shows (copy of a stable code, focus
// on the first field), the confirmation before the model behind a released entry changes, and the actions of a row.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminCatalogEntry,
  AdminCatalogView,
} from "../../model-catalog/admin-view.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { CatalogApi } from "./catalog-api.ts";
import { ModelCatalogSection } from "./catalog-section.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const AT = "2026-10-17T10:00:00.000Z";
const SMALL: AdminCatalogEntry = {
  id: "mce_small",
  name: "Small",
  description: "Quick reviews that point out the obvious problems.",
  provider: "openrouter",
  modelId: "acme/quick-1",
  kinds: ["diff"],
  status: "released",
  sortOrder: 0,
  updatedAt: AT,
  usedByProjects: 3,
};
const BIG: AdminCatalogEntry = {
  ...SMALL,
  id: "mce_big",
  name: "Big",
  description: null,
  modelId: "acme/deep-9",
  kinds: ["diff", "dynamic"],
  status: "draft",
  sortOrder: 1,
  usedByProjects: 0,
};
const OLD: AdminCatalogEntry = {
  ...SMALL,
  id: "mce_old",
  name: "Old",
  modelId: "acme/old-0",
  status: "retired",
  sortOrder: 2,
  usedByProjects: 1,
};

function catalogOf(
  entries: AdminCatalogEntry[],
  defaults: AdminCatalogView["defaults"] = { diff: null, dynamic: null },
): AdminCatalogView {
  return {
    entries,
    defaults,
    providers: [{ id: "openrouter", label: "OpenRouter" }],
  };
}

type Answer = RequestResult<{ ok: true }>;
const OK: Answer = { ok: true, data: { ok: true } };
const refused = (code: string, field?: string): Answer => ({
  ok: false,
  status: 422,
  code,
  issues: field === undefined ? [] : [{ field, code }],
});

const CHECKED = { ok: true, data: { ok: true, verified: true } };

function api(answers: Partial<Record<keyof CatalogApi, unknown>> = {}) {
  const mockOf = (answer: unknown) =>
    vi.fn<(...args: unknown[]) => Promise<RequestResult<unknown>>>(() =>
      Promise.resolve(answer as RequestResult<unknown>),
    );
  const calls = {
    create: mockOf(answers.create ?? OK),
    update: mockOf(answers.update ?? OK),
    release: mockOf(answers.release ?? OK),
    retire: mockOf(answers.retire ?? OK),
    remove: mockOf(answers.remove ?? OK),
    setDefaults: mockOf(answers.setDefaults ?? OK),
    check: mockOf(answers.check ?? CHECKED),
  };
  return { api: calls as unknown as CatalogApi, ...calls };
}

function renderSection(catalog: AdminCatalogView, mock = api()) {
  render(<ModelCatalogSection catalog={catalog} api={mock.api} />);
  return mock;
}

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add model" }));
  return screen.getByRole("dialog");
}

describe("the section", () => {
  it("is collapsed and says who needs it while the catalog is empty, and opens on request", async () => {
    const user = userEvent.setup();
    renderSection(catalogOf([]));

    expect(
      screen.getByText(/only needed for workspaces whose key mode is managed/i),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add model" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /model catalog/i }));

    expect(screen.getByRole("button", { name: "Add model" })).toBeTruthy();
    expect(screen.getByText(/no models yet/i)).toBeTruthy();
  });

  // #429-T05
  it("lists every entry for the admin, a retired one too, with the model, the kinds, the status and the use", () => {
    renderSection(catalogOf([SMALL, BIG, OLD]));

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const small = within(rows[0]!);
    expect(small.getByText("Small")).toBeTruthy();
    expect(small.getByText("OpenRouter")).toBeTruthy();
    expect(small.getByText("acme/quick-1")).toBeTruthy();
    expect(small.getByText("Diff")).toBeTruthy();
    expect(small.getByText("Released")).toBeTruthy();
    expect(small.getByText(/3 projects/)).toBeTruthy();
    expect(within(rows[1]!).getByText("Draft")).toBeTruthy();
    expect(within(rows[1]!).getByText("Diff, Dynamic")).toBeTruthy();
    expect(within(rows[2]!).getByText("Old")).toBeTruthy();
    expect(within(rows[2]!).getByText("Retired")).toBeTruthy();
    expect(within(rows[2]!).getByText(/1 project\b/)).toBeTruthy();
  });
});

describe("the form", () => {
  // #429-T04
  it("warns that members see the name, and never the model behind it", async () => {
    const user = userEvent.setup();
    renderSection(catalogOf([SMALL]));

    const dialog = await openAdd(user);

    expect(
      within(dialog).getByText(/members .*see this name/i).textContent,
    ).toMatch(/never the model/i);
  });

  // #429-T04
  it("limits the name to the 40 characters the rule allows", async () => {
    const user = userEvent.setup();
    renderSection(catalogOf([SMALL]));

    const dialog = await openAdd(user);

    expect(
      (within(dialog).getByLabelText("Name") as HTMLInputElement).maxLength,
    ).toBe(40);
  });

  it("sends what was typed and closes after a save", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL]));

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Name"), "Medium");
    await user.type(
      within(dialog).getByLabelText("Description"),
      "Careful reviews.",
    );
    await user.type(within(dialog).getByLabelText("Model id"), "acme/mid-2");
    await user.click(within(dialog).getByRole("checkbox", { name: "Diff" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mock.create).toHaveBeenCalled());
    expect(mock.create).toHaveBeenCalledWith({
      name: "Medium",
      description: "Careful reviews.",
      provider: "openrouter",
      modelId: "acme/mid-2",
      kinds: ["diff"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("checks the model with the provider and the kinds chosen, and says what it found", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL]));

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Model id"), "acme/mid-2");
    await user.click(within(dialog).getByRole("checkbox", { name: "Dynamic" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Check model" }),
    );

    await waitFor(() => expect(mock.check).toHaveBeenCalled());
    expect(mock.check).toHaveBeenCalledWith({
      provider: "openrouter",
      modelId: "acme/mid-2",
      kinds: ["dynamic"],
    });
    expect(await within(dialog).findByText(/supports what/i)).toBeTruthy();
  });

  it("shows the copy of the code the check was refused with, never the code", async () => {
    const user = userEvent.setup();
    renderSection(
      catalogOf([]),
      api({
        check: {
          ok: true,
          data: { ok: false, error: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /model catalog/i }));

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Model id"), "acme/no-tools");
    await user.click(within(dialog).getByRole("checkbox", { name: "Dynamic" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Check model" }),
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/tool/i);
    expect(alert.textContent).not.toContain("DYNAMIC_MODEL_TOOLS_UNSUPPORTED");
  });

  // #429-T03
  it("shows a refusal as copy next to its field, and not as the code", async () => {
    const user = userEvent.setup();
    renderSection(
      catalogOf([SMALL]),
      api({ create: refused("name_reveals_model", "name") }),
    );

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Name"), "acme/quick-1");
    await user.type(within(dialog).getByLabelText("Model id"), "acme/quick-1");
    await user.click(within(dialog).getByRole("checkbox", { name: "Diff" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const name = within(dialog).getByLabelText("Name");
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
    expect(dialog.textContent).toMatch(/gives away the model/i);
    expect(dialog.textContent).not.toContain("name_reveals_model");
  });

  // #429-T07
  it("moves the focus to the first field that was refused", async () => {
    const user = userEvent.setup();
    renderSection(
      catalogOf([SMALL]),
      api({
        create: {
          ok: false,
          status: 422,
          code: "invalid_input",
          issues: [
            { field: "modelId", code: "model_id_invalid" },
            { field: "name", code: "name_invalid" },
          ],
        },
      }),
    );

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Name"), " ");
    await user.type(within(dialog).getByLabelText("Model id"), "x");
    await user.click(within(dialog).getByRole("checkbox", { name: "Diff" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // The first of the fields as the form shows them, not as the server listed them.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByLabelText("Name"),
      ),
    );
    expect(
      within(dialog).getByLabelText("Model id").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  // #429-T07
  it("moves the focus to the kinds when none is chosen, without asking the server", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL]));

    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText("Name"), "Medium");
    await user.type(within(dialog).getByLabelText("Model id"), "acme/mid-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("checkbox", { name: "Diff" }),
      ),
    );
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("edits an entry with its current values and sends the change", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([BIG]));

    await user.click(screen.getByRole("button", { name: "Edit Big" }));
    const dialog = screen.getByRole("dialog");
    expect(
      (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
    ).toBe("Big");
    expect(
      (within(dialog).getByLabelText("Model id") as HTMLInputElement).value,
    ).toBe("acme/deep-9");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Bigger");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mock.update).toHaveBeenCalled());
    expect(mock.update).toHaveBeenCalledWith("mce_big", {
      name: "Bigger",
      description: null,
      provider: "openrouter",
      modelId: "acme/deep-9",
      kinds: ["diff", "dynamic"],
    });
  });
});

describe("changing the model behind a released entry", () => {
  // #429-T09
  it("asks first, shows how many projects use the entry, and sends the change only when confirmed", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL]));

    await user.click(screen.getByRole("button", { name: "Edit Small" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Model id"));
    await user.type(within(dialog).getByLabelText("Model id"), "acme/better-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation.textContent).toMatch(/3 projects/);
    expect(mock.update).not.toHaveBeenCalled();

    await user.click(
      within(confirmation).getByRole("button", { name: "Change the model" }),
    );

    await waitFor(() => expect(mock.update).toHaveBeenCalled());
    expect(mock.update).toHaveBeenCalledWith(
      "mce_small",
      expect.objectContaining({
        modelId: "acme/better-2",
        confirmModelChange: true,
      }),
    );
  });

  // #429-T09
  it("sends nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL]));

    await user.click(screen.getByRole("button", { name: "Edit Small" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Model id"));
    await user.type(within(dialog).getByLabelText("Model id"), "acme/better-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );

    expect(mock.update).not.toHaveBeenCalled();
  });

  // #429-T09
  it("does not ask when only the name changes, or when the entry is a draft", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL, BIG]));

    await user.click(screen.getByRole("button", { name: "Edit Small" }));
    let dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), " 2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Edit Big" }));
    dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Model id"));
    await user.type(within(dialog).getByLabelText("Model id"), "acme/deeper");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mock.update.mock.calls[0]?.[1]).not.toHaveProperty(
      "confirmModelChange",
    );
  });
});

describe("the actions of a row", () => {
  it("releases a draft and a retired entry, and retires a released one after a confirmation with the count", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL, BIG, OLD]));

    await user.click(screen.getByRole("button", { name: "Release Big" }));
    await user.click(screen.getByRole("button", { name: "Release Old" }));
    await waitFor(() => expect(mock.release).toHaveBeenCalledTimes(2));
    expect(mock.release.mock.calls.map((call) => call[0])).toEqual([
      "mce_big",
      "mce_old",
    ]);

    await user.click(screen.getByRole("button", { name: "Retire Small" }));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation.textContent).toMatch(/3 projects/);
    expect(mock.retire).not.toHaveBeenCalled();
    await user.click(
      within(confirmation).getByRole("button", { name: "Retire" }),
    );
    await waitFor(() => expect(mock.retire).toHaveBeenCalledWith("mce_small"));
  });

  it("deletes a draft after a confirmation, and offers no delete for a released or a retired entry", async () => {
    const user = userEvent.setup();
    const mock = renderSection(catalogOf([SMALL, BIG, OLD]));

    expect(screen.queryByRole("button", { name: "Delete Small" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Old" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete Big" }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() => expect(mock.remove).toHaveBeenCalledWith("mce_big"));
  });

  it("shows a refusal of an action as copy", async () => {
    const user = userEvent.setup();
    renderSection(
      catalogOf([BIG]),
      api({ release: refused("DYNAMIC_MODEL_TOOLS_UNSUPPORTED") }),
    );

    await user.click(screen.getByRole("button", { name: "Release Big" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/tool/i);
    expect(alert.textContent).not.toContain("DYNAMIC_MODEL_TOOLS_UNSUPPORTED");
  });

  it("sets and clears the default of a kind for a released entry that serves it, keeping the other kind", async () => {
    const user = userEvent.setup();
    const releasedBoth: AdminCatalogEntry = {
      ...BIG,
      status: "released",
    };
    const mock = renderSection(
      catalogOf([SMALL, releasedBoth], { diff: null, dynamic: "mce_big" }),
    );

    const diff = screen.getByRole("button", {
      name: "Small: default for Diff",
    });
    expect(diff.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Big: default for Dynamic" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // Small serves Diff only.
    expect(
      screen.queryByRole("button", { name: "Small: default for Dynamic" }),
    ).toBeNull();

    await user.click(diff);
    await waitFor(() =>
      expect(mock.setDefaults).toHaveBeenCalledWith({
        diff: "mce_small",
        dynamic: "mce_big",
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Big: default for Dynamic" }),
    );
    await waitFor(() =>
      expect(mock.setDefaults).toHaveBeenLastCalledWith({
        diff: null,
        dynamic: null,
      }),
    );
  });

  it("offers no default for a draft or a retired entry", () => {
    renderSection(catalogOf([BIG, OLD]));

    expect(screen.queryByRole("button", { name: /default for/i })).toBeNull();
  });

  it("moves an entry up or down by re-numbering the entries that changed place", async () => {
    const user = userEvent.setup();
    const mock = renderSection(
      catalogOf([
        { ...SMALL, sortOrder: 0 },
        { ...BIG, sortOrder: 0 },
        { ...OLD, sortOrder: 0 },
      ]),
    );

    expect(
      screen
        .getByRole("button", { name: "Move Small up" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Move Big up" }));

    await waitFor(() => expect(mock.update).toHaveBeenCalled());
    const sent = Object.fromEntries(
      mock.update.mock.calls.map((call) => [
        call[0] as string,
        (call[1] as { sortOrder: number }).sortOrder,
      ]),
    );
    // Big first, then Small, then Old: the order the page now shows. Big is at 0 already, so only the others are sent.
    expect(sent).toEqual({ mce_small: 1, mce_old: 2 });
  });

  it("shows which entry is the default of each kind", () => {
    renderSection(catalogOf([SMALL], { diff: "mce_small", dynamic: null }));

    expect(screen.getByText(/default for diff: small/i)).toBeTruthy();
    expect(screen.getByText(/default for dynamic: none/i)).toBeTruthy();
  });
});
