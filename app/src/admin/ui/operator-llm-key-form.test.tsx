// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the page of the operator's own LLM key (#276): what the form sends (the typed key, or null for the
// removal), that the key is write-only (the field is emptied after a save and the page only ever says whether a
// key is saved, cannot be read or is missing, and the last four characters), the sentence for every field the
// server refuses with the focus on the field, and the removal in a confirmed danger zone.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { OperatorLlmKeyStatus } from "../../llm/operator-key.ts";
import type { AdminApi, SettingChange } from "./api.ts";
import { OperatorLlmKeyForm } from "./operator-llm-key-form.tsx";
import type { AdminSettingsView } from "../service.ts";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const KEY = "sk-or-v1-typed-key-0123456789abcdef-wxyz";

const NOT_CONFIGURED: OperatorLlmKeyStatus = { state: "not_configured" };
const CONFIGURED: OperatorLlmKeyStatus = {
  state: "configured",
  lastFour: "wxyz",
  updatedAt: "2026-10-12T08:00:00.000Z",
  updatedBy: "admin-1",
};
const UNREADABLE: OperatorLlmKeyStatus = {
  state: "unreadable",
  updatedAt: "2026-10-12T08:00:00.000Z",
  updatedBy: "admin-1",
};

function api(
  result: RequestResult<{ ok: true; settings: AdminSettingsView }> = {
    ok: true,
    data: { ok: true, settings: {} as AdminSettingsView },
  },
) {
  const changeMock = vi.fn<(change: SettingChange) => Promise<typeof result>>(
    () => Promise.resolve(result),
  );
  return {
    api: {
      change: changeMock,
      testMail: vi.fn(),
    } satisfies AdminApi,
    changeMock,
  };
}

describe("the operator's key form", () => {
  // #276-T06
  it("sends the typed key, empties the field and says it was saved", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<OperatorLlmKeyForm status={NOT_CONFIGURED} api={mock} />);

    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock).toHaveBeenCalledWith({
      operatorLlmKey: { apiKey: KEY },
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Saved."),
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(navigation.refresh).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(KEY);
  });

  // #276-T06
  it("is a password field the browser does not fill in or remember", () => {
    render(<OperatorLlmKeyForm status={NOT_CONFIGURED} api={api().api} />);

    const field = screen.getByLabelText("API key");

    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
  });

  // #276-T06
  it("says in one line whether a key is saved, and shows the last four characters only", () => {
    const { rerender } = render(
      <OperatorLlmKeyForm status={NOT_CONFIGURED} api={api().api} />,
    );
    expect(screen.getByText(/^No key is saved\./)).toBeTruthy();

    rerender(<OperatorLlmKeyForm status={CONFIGURED} api={api().api} />);
    expect(screen.getByText(/A key is saved, ending in wxyz\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-or");

    rerender(
      <OperatorLlmKeyForm
        status={{ ...CONFIGURED, lastFour: null }}
        api={api().api}
      />,
    );
    expect(screen.getByText(/A key is saved\./)).toBeTruthy();
    expect(screen.queryByText(/ending in/)).toBeNull();

    rerender(<OperatorLlmKeyForm status={UNREADABLE} api={api().api} />);
    expect(screen.getByText(/The saved key cannot be read/)).toBeTruthy();
    expect(screen.getByText(/another APP_SECRET/)).toBeTruthy();
  });

  // #276-T06
  it("tells the sentence of the issue the server found and moves the focus to the field", async () => {
    const { api: mock } = api({
      ok: false,
      code: "invalid_input",
      status: 422,
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
    const user = userEvent.setup();
    render(<OperatorLlmKeyForm status={NOT_CONFIGURED} api={mock} />);

    await user.type(screen.getByLabelText("API key"), "has a space");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(screen.getByText(/does not look like an API key/)).toBeTruthy(),
    );
    expect(document.activeElement).toBe(screen.getByLabelText("API key"));
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  // #276-T06
  it("removes the key from a confirmed danger zone, and offers it only while a key is stored", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    const { rerender } = render(
      <OperatorLlmKeyForm status={NOT_CONFIGURED} api={mock} />,
    );
    expect(screen.queryByRole("button", { name: "Remove the key" })).toBeNull();

    rerender(<OperatorLlmKeyForm status={CONFIGURED} api={mock} />);
    await user.click(screen.getByRole("button", { name: "Remove the key" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(changeMock).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove the key" }),
    );

    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ operatorLlmKey: null }),
    );

    // A key that cannot be read can be removed as well.
    rerender(<OperatorLlmKeyForm status={UNREADABLE} api={mock} />);
    expect(screen.getByRole("button", { name: "Remove the key" })).toBeTruthy();
  });

  // #276-T06
  it("explains what the key is for without naming a price or a plan", () => {
    render(<OperatorLlmKeyForm status={CONFIGURED} api={api().api} />);

    const text = document.body.textContent ?? "";

    expect(text).toMatch(/managed/);
    expect(text).toMatch(/stored encrypted/);
    expect(text).not.toMatch(/\$|€|price|plan|payment/i);
  });
});
