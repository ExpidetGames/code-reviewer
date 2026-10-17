// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the billing page (#437): what the form sends (the typed secrets only when typed), that the secrets are
// write-only (the fields are emptied after a save and the page only says whether each is saved, with the last four
// characters), the copy for a refusal, the notice before the switch, and the switch itself.
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
import type {
  BillingApi,
  BillingChange,
  BillingCheckAnswer,
} from "./billing-api.ts";
import { BillingForm } from "./billing-form.tsx";
import type { BillingView } from "./billing-view.ts";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const API_KEY = "pdl_sdbx_apikey_typed_0123456789abcdef_wxyz";
const NOTICE = ["The Free plan is managed.", "2 workspaces are affected."];

const EMPTY: BillingView = {
  environment: "sandbox",
  clientToken: "",
  graceDays: 7,
  enabled: false,
  apiKey: { state: "not_configured" },
  webhookSecret: { state: "not_configured" },
  ownKeyWorkspaces: 2,
  updatedAt: null,
};
const READY: BillingView = {
  ...EMPTY,
  clientToken: "test_token_0123456789",
  apiKey: { state: "configured", lastFour: "wxyz" },
  webhookSecret: { state: "configured", lastFour: "abcd" },
};

function api(
  change: RequestResult<{ ok: true; billing: BillingView }> = {
    ok: true,
    data: { ok: true, billing: READY },
  },
  check: RequestResult<BillingCheckAnswer> = { ok: true, data: { ok: true } },
) {
  const changeMock = vi.fn<(c: BillingChange) => Promise<typeof change>>(() =>
    Promise.resolve(change),
  );
  const checkMock = vi.fn(() => Promise.resolve(check));
  const destinationMock = vi.fn(() =>
    Promise.resolve({ ok: true, data: { ok: true, billing: READY } } as const),
  );
  return {
    api: {
      change: changeMock,
      check: checkMock,
      createDestination: destinationMock,
    } satisfies BillingApi,
    changeMock,
    checkMock,
    destinationMock,
  };
}

describe("the billing form", () => {
  // #437-T02
  it("sends the typed secrets, empties the fields and never shows what it sent", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<BillingForm billing={EMPTY} notice={NOTICE} api={mock} />);

    await user.type(screen.getByLabelText("API key"), API_KEY);
    await user.type(screen.getByLabelText("Client-side token"), "test_token_1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock).toHaveBeenCalledWith({
      settings: {
        environment: "sandbox",
        clientToken: "test_token_1",
        graceDays: 7,
        apiKey: API_KEY,
      },
    });
    await waitFor(() =>
      expect(screen.getAllByRole("status")[0]?.textContent).toBe("Saved."),
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(navigation.refresh).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(API_KEY);
  });

  // #437-T02
  it("says which secrets are saved, with the last four characters, and sends none that was left empty", async () => {
    const { api: mock, changeMock } = api();
    const user = userEvent.setup();
    render(<BillingForm billing={READY} notice={NOTICE} api={mock} />);

    expect(document.body.textContent).toContain("ending in wxyz");
    expect(document.body.textContent).toContain("ending in abcd");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(changeMock).toHaveBeenCalled());
    expect(changeMock).toHaveBeenCalledWith({
      settings: {
        environment: "sandbox",
        clientToken: "test_token_0123456789",
        graceDays: 7,
      },
    });
  });

  // #437-T03
  it("shows the sentence of the refused field", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
    const user = userEvent.setup();
    render(<BillingForm billing={EMPTY} notice={NOTICE} api={mock} />);

    await user.type(screen.getByLabelText("API key"), "nonsense");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/not a Paddle API key/)).toBeTruthy();
  });

  // #437-T03
  it("warns when the environment is switched, and does not allow it while billing is on", async () => {
    const user = userEvent.setup();
    render(<BillingForm billing={READY} notice={NOTICE} api={api().api} />);

    await user.click(screen.getByRole("radio", { name: "Live" }));
    expect(screen.getByText(/separate API keys, notification/)).toBeTruthy();

    cleanup();
    render(
      <BillingForm
        billing={{ ...READY, enabled: true }}
        notice={NOTICE}
        api={api().api}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Live" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Switch billing off to change the environment."),
    ).toBeTruthy();
  });

  // #437-T04
  it("runs the connection check and shows the sentence of its code", async () => {
    const { api: mock, checkMock } = api(undefined, {
      ok: true,
      data: { ok: false, error: "paddle_key_rejected" },
    });
    const user = userEvent.setup();
    render(<BillingForm billing={READY} notice={NOTICE} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Check connection" }));

    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    expect(await screen.findByText(/did not accept the API key/)).toBeTruthy();
  });

  // #437-T05
  it("creates the notification destination only with a key and without a webhook secret", async () => {
    const user = userEvent.setup();
    const first = api();
    render(
      <BillingForm
        billing={{ ...READY, webhookSecret: { state: "not_configured" } }}
        notice={NOTICE}
        api={first.api}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Create notification destination" }),
    );
    await waitFor(() => expect(first.destinationMock).toHaveBeenCalled());
    cleanup();

    render(<BillingForm billing={READY} notice={NOTICE} api={api().api} />);
    expect(
      screen
        .getByRole("button", { name: "Create notification destination" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  // #437-T06
  it("names what is missing before the switch, and shows the notice with the count", () => {
    render(<BillingForm billing={EMPTY} notice={NOTICE} api={api().api} />);

    const region = screen.getByRole("region", { name: "Billing is off" });
    expect(within(region).getByText("The Free plan is managed.")).toBeTruthy();
    expect(within(region).getByText("2 workspaces are affected.")).toBeTruthy();
    expect(within(region).getByText("The Paddle API key")).toBeTruthy();
    expect(within(region).getByText("The client-side token")).toBeTruthy();
  });

  // #437-T06
  it("switches billing on, and shows the reason when it is refused", async () => {
    const accepted = api();
    const user = userEvent.setup();
    render(<BillingForm billing={READY} notice={NOTICE} api={accepted.api} />);

    await user.click(screen.getByRole("switch", { name: "Switch billing on" }));
    await waitFor(() =>
      expect(accepted.changeMock).toHaveBeenCalledWith({ enabled: true }),
    );
    cleanup();

    const refused = api({
      ok: false,
      status: 409,
      code: "billing_incomplete",
      issues: [],
    });
    render(<BillingForm billing={READY} notice={NOTICE} api={refused.api} />);
    await user.click(screen.getByRole("switch", { name: "Switch billing on" }));

    expect(await screen.findByText(/cannot be switched on yet/)).toBeTruthy();
  });
});
