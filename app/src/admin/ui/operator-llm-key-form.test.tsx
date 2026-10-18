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
import {
  OperatorLlmKeyForm,
  OperatorLlmKeys,
} from "./operator-llm-key-form.tsx";
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
  const testMock = vi.fn<AdminApi["testLlmKey"]>(() =>
    Promise.resolve({ ok: true, data: { ok: true } }),
  );
  return {
    api: {
      change: changeMock,
      testMail: vi.fn(),
      testLlmKey: testMock,
    } satisfies AdminApi,
    testMock,
    changeMock,
  };
}

describe("the operator's key form", () => {
  // #276-T06
  it("sends the typed key, empties the field and says it was saved", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={mock}
      />,
    );

    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock).toHaveBeenCalledWith({
      operatorLlmKeys: { openrouter: { apiKey: KEY } },
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
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={api().api}
      />,
    );

    const field = screen.getByLabelText("API key");

    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
  });

  // #276-T06
  it("says in one line whether a key is saved, and shows the last four characters only", () => {
    const { rerender } = render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={api().api}
      />,
    );
    expect(screen.getByText(/^No key is saved\./)).toBeTruthy();

    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={CONFIGURED}
        api={api().api}
      />,
    );
    expect(screen.getByText(/A key is saved, ending in wxyz\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-or");

    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={{ ...CONFIGURED, lastFour: null }}
        api={api().api}
      />,
    );
    expect(screen.getByText(/A key is saved\./)).toBeTruthy();
    expect(screen.queryByText(/ending in/)).toBeNull();

    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={UNREADABLE}
        api={api().api}
      />,
    );
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
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={mock}
      />,
    );

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
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={mock}
      />,
    );
    expect(screen.queryByRole("button", { name: "Remove the key" })).toBeNull();

    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={CONFIGURED}
        api={mock}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove the key" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(changeMock).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove the key" }),
    );

    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({
        operatorLlmKeys: { openrouter: null },
      }),
    );

    // A key that cannot be read can be removed as well.
    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={UNREADABLE}
        api={mock}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove the key" })).toBeTruthy();
  });

  // #276-T06
  it("explains what the key is for without naming a price or a plan", () => {
    render(
      <OperatorLlmKeys keys={{ openrouter: CONFIGURED }} api={api().api} />,
    );

    const text = document.body.textContent ?? "";

    expect(text).toMatch(/managed/);
    expect(text).toMatch(/stored encrypted/);
    expect(text).not.toMatch(/\$|€|price|plan|payment/i);
  });
});

describe("the card of one provider (#427)", () => {
  // #427-T01
  it("names the provider in its region and in the label of its form", () => {
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={api().api}
      />,
    );

    expect(screen.getByRole("region", { name: "OpenRouter" })).toBeTruthy();
    expect(
      screen.getByRole("form", { name: "OpenRouter LLM key" }),
    ).toBeTruthy();
  });

  // #427-T01
  it("tests the typed key of its provider and says that the provider accepted it, without echoing the key", async () => {
    const { api: mock, testMock } = api();
    const user = userEvent.setup();
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={mock}
      />,
    );

    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Test key" }));

    await waitFor(() =>
      expect(testMock).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: KEY,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("The provider accepted the key.")).toBeTruthy(),
    );
    expect(document.body.textContent).not.toContain(KEY);
  });

  // #427-T01
  it("tests the stored key when the field is empty, and has nothing to test without either", async () => {
    const { api: mock, testMock } = api();
    const user = userEvent.setup();
    const { rerender } = render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={NOT_CONFIGURED}
        api={mock}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Test key" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rerender(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={CONFIGURED}
        api={mock}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Test key" }));

    await waitFor(() =>
      expect(testMock).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: "",
      }),
    );
  });

  // #427-T07
  it("shows the class of a failed test as a sentence and the cleaned detail, and the wait of a rate limit", async () => {
    const { api: mock, testMock } = api();
    const user = userEvent.setup();
    render(
      <OperatorLlmKeyForm
        provider="openrouter"
        label="OpenRouter"
        status={CONFIGURED}
        api={mock}
      />,
    );
    testMock.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, error: "llm_key_rejected", detail: "No auth" },
    });
    await user.click(screen.getByRole("button", { name: "Test key" }));
    await waitFor(() =>
      expect(screen.getByText(/did not accept this key/)).toBeTruthy(),
    );
    expect(screen.getByText("No auth")).toBeTruthy();

    testMock.mockResolvedValueOnce({
      ok: false,
      code: "rate_limited",
      status: 429,
      issues: [],
    });
    await user.click(screen.getByRole("button", { name: "Test key" }));
    await waitFor(() =>
      expect(screen.getByText(/tested too often/)).toBeTruthy(),
    );
  });
});

describe("the page of the operator's keys (#427)", () => {
  const TWO = { openrouter: CONFIGURED, fakeai: NOT_CONFIGURED } as const;

  // #427-T01
  it("has one card for each provider, in order, with the status of its own key", () => {
    render(<OperatorLlmKeys keys={TWO} api={api().api} />);

    const openrouter = screen.getByRole("region", { name: "OpenRouter" });
    const fakeai = screen.getByRole("region", { name: "fakeai" });
    expect(openrouter.textContent).toContain("ending in wxyz");
    expect(fakeai.textContent).toContain("No key is saved");
    expect(
      openrouter.compareDocumentPosition(fakeai) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // #427-T01
  it("saves and removes the key of one provider and sends the name of that provider only", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<OperatorLlmKeys keys={TWO} api={mock} />);
    const fakeai = within(screen.getByRole("region", { name: "fakeai" }));

    await user.type(fakeai.getByLabelText("API key"), KEY);
    await user.click(fakeai.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({
        operatorLlmKeys: { fakeai: { apiKey: KEY } },
      }),
    );
    expect(changeMock).toHaveBeenCalledTimes(1);

    const openrouter = within(
      screen.getByRole("region", { name: "OpenRouter" }),
    );
    expect(
      (openrouter.getByLabelText("API key") as HTMLInputElement).value,
    ).toBe("");
    await user.click(
      openrouter.getByRole("button", { name: "Remove the key" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove the key" }),
    );
    await waitFor(() =>
      expect(changeMock).toHaveBeenLastCalledWith({
        operatorLlmKeys: { openrouter: null },
      }),
    );
  });
});
