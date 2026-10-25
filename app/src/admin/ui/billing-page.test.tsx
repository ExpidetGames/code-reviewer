// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the billing page of the admin portal (#504): the statement of what switching on does and what is missing, the
// switch, the adapter and the write-only Stripe fields, the rates shown as US dollars and sent as whole numbers, and the manual
// credit with its required note. The server judges every value; the page shows the reason it gets back.
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
import type { BillingApi, BillingChange } from "./billing-api.ts";
import { BillingPage } from "./billing-page.tsx";
import type {
  BillingView,
  BillingWorkspaceBalanceView,
} from "./billing-view.ts";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const KEY = "sk_test_TypedKeyForTheTest0123456789";
const SECRET = "whsec_TypedSecretForTheTest0123456789";

const VIEW: BillingView = {
  enabled: false,
  on: false,
  adapter: "manual",
  missing: [
    "factor_a_missing",
    "minute_rate_diff_missing",
    "minute_rate_dynamic_missing",
    "diff_ai_reserve_missing",
  ],
  stripe: {
    apiKey: { state: "not_configured" },
    webhookSecret: { state: "not_configured" },
    environment: null,
    checkedAt: null,
    webhookEndpointId: null,
    webhookUrl: "https://reviews.example.test/api/billing/webhook",
    webhookUrlPublic: true,
  },
  legal: { termsUrl: null, privacyUrl: null },
  journalCheck: {
    state: "never",
    checkedAt: null,
    workspaces: 0,
    inconsistentWorkspaces: 0,
  },
  rates: {
    factorA: null,
    diffMinuteRateMicroUsd: null,
    dynamicMinuteRateMicroUsd: null,
    diffAiReserveMicroUsd: null,
  },
  numbers: {
    startCreditMicroUsd: 2_000_000,
    lowBalanceMicroUsd: 5_000_000,
    hourlyReviewLimit: 60,
    startCreditStored: false,
    lowBalanceStored: false,
    hourlyReviewLimitStored: false,
  },
  workspaces: 4,
  ownKeyWorkspaces: 1,
  updatedAt: null,
};

const RATED: BillingView = {
  ...VIEW,
  missing: [],
  rates: {
    factorA: 50_000,
    diffMinuteRateMicroUsd: 13_000,
    dynamicMinuteRateMicroUsd: 16_000,
    diffAiReserveMicroUsd: 150_000,
  },
};

const STRIPE_VIEW: BillingView = {
  ...RATED,
  adapter: "stripe",
  missing: [
    "stripe_api_key_missing",
    "stripe_webhook_secret_missing",
    "connection_check_missing",
    "terms_url_missing",
  ],
};

const NOTICE = [
  "Once billing is on, the reviews of every workspace are charged from a prepaid balance.",
  "This instance has 4 workspaces. 1 of them holds a stored own key.",
];

const WORKSPACE: BillingWorkspaceBalanceView = {
  workspace: { id: "ws-1", name: "Acme", slug: "acme" },
  balanceMicroUsd: 8_000_000,
  reservedMicroUsd: 0,
  entries: [
    {
      id: "e1",
      type: "top_up",
      amountMicroUsd: 10_000_000,
      provider: "manual",
      note: "Pilot customer",
      createdAt: "2026-10-20T08:00:00.000Z",
    },
  ],
};

type Overrides = Partial<{
  change: (change: BillingChange) => ReturnType<BillingApi["change"]>;
}>;

function api(overrides: Overrides = {}, billing: BillingView = VIEW) {
  const ok = <T,>(data: T): Promise<RequestResult<T>> =>
    Promise.resolve({ ok: true, data });
  const change = vi.fn<BillingApi["change"]>((change) =>
    overrides.change === undefined
      ? ok({ ok: true as const, billing })
      : overrides.change(change),
  );
  return {
    change,
    check: vi.fn<BillingApi["check"]>(() =>
      ok({ ok: true as const, environment: "test" as const }),
    ),
    createWebhookEndpoint: vi.fn<BillingApi["createWebhookEndpoint"]>(() =>
      ok({ ok: true as const, created: true, billing }),
    ),
    searchWorkspaces: vi.fn<BillingApi["searchWorkspaces"]>(() =>
      ok({ workspaces: [WORKSPACE.workspace] }),
    ),
    workspace: vi.fn<BillingApi["workspace"]>(() => ok(WORKSPACE)),
    credit: vi.fn<BillingApi["credit"]>(() =>
      ok({ ok: true as const, workspace: WORKSPACE }),
    ),
  } satisfies BillingApi;
}

const failure = (
  code: string,
  issues: Array<{ field: string; code: string }> = [],
  details?: Record<string, unknown>,
): Promise<RequestResult<never>> =>
  Promise.resolve({
    ok: false,
    status: 422,
    code,
    issues,
    ...(details === undefined ? {} : { details }),
  });

describe("the switch and the statement", () => {
  // #504-T13
  it("states what switching on does, with the counts, while billing is off", () => {
    render(<BillingPage billing={VIEW} notice={NOTICE} api={api()} />);

    expect(
      screen.getByRole("heading", { name: "Billing is off" }),
    ).toBeTruthy();
    expect(screen.getByText(NOTICE[0] ?? "")).toBeTruthy();
    expect(screen.getByText(NOTICE[1] ?? "")).toBeTruthy();
  });

  // #504-T03
  it("lists what is missing, in words, before billing can be switched on", () => {
    render(<BillingPage billing={VIEW} notice={NOTICE} api={api()} />);

    const list = screen.getByText("Before billing can be on:")
      .parentElement as HTMLElement;
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual([
      "The factor A",
      "The rate per started minute for Diff reviews",
      "The rate per started minute for Dynamic reviews",
      "The AI reserve of a Diff review",
    ]);
  });

  // #504-T04
  it("switches on and says so", async () => {
    const mock = api({}, { ...RATED, enabled: true, on: true });
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("switch", { name: "Switch billing on" }));

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({ enabled: true }),
    );
    expect(await screen.findByText("Billing is on.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #504-T03
  it("shows the refusal and the missing items the server names", async () => {
    const mock = api({
      change: () =>
        failure("billing_not_ready", [], {
          missing: ["factor_a_missing", "connection_check_missing"],
        }),
    });
    render(<BillingPage billing={VIEW} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("switch", { name: "Switch billing on" }));

    const note = await screen.findByText(/Billing cannot be switched on yet/);
    const items = within(note.closest("[role=note]") as HTMLElement)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["The factor A", "A passing connection check"]);
  });

  // #504-T14
  it("switches off from the running state, and says the switch is on but billing is not running when it lost something", () => {
    const { rerender } = render(
      <BillingPage
        billing={{ ...RATED, enabled: true, on: true }}
        notice={NOTICE}
        api={api()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Billing is on" })).toBeTruthy();
    expect(screen.queryByText(NOTICE[0] ?? "")).toBeNull();

    rerender(
      <BillingPage
        billing={{
          ...VIEW,
          enabled: true,
          on: false,
        }}
        notice={NOTICE}
        api={api()}
      />,
    );
    expect(
      screen.getByText(/The switch is on, but billing is not running/),
    ).toBeTruthy();
  });
});

describe("a switch that is on while the setup is not complete (#632)", () => {
  // #632-T07
  it("says that every review is refused, not that reviews run uncharged, and lists the terms link of a setup saved before it existed", () => {
    render(
      <BillingPage
        billing={{
          ...RATED,
          enabled: true,
          on: false,
          adapter: "stripe",
          missing: ["terms_url_missing"],
        }}
        notice={NOTICE}
        api={api()}
      />,
    );

    const warning = screen
      .getByText(/The switch is on, but billing is not running/)
      .closest("[role=note]") as HTMLElement;
    expect(warning.textContent).toMatch(/every review is refused/i);
    expect(warning.textContent).not.toMatch(/not charged/i);
    expect(screen.getByText("The link to your terms")).toBeTruthy();
    // The admin completes it: nothing is filled in for them.
    expect(
      (screen.getByLabelText("Link to the terms") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("the payment adapter and the Stripe credentials", () => {
  // #504-T04
  it("chooses Stripe and shows its fields only then", async () => {
    const mock = api();
    const { rerender } = render(
      <BillingPage billing={RATED} notice={NOTICE} api={mock} />,
    );
    expect(screen.queryByLabelText("Stripe API key")).toBeNull();

    await userEvent
      .setup()
      .click(screen.getByRole("radio", { name: /^Stripe:/ }));

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({ adapter: "stripe" }),
    );
    rerender(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />);
    expect(screen.getByLabelText("Stripe API key")).toBeTruthy();
    expect(screen.getByLabelText("Webhook secret")).toBeTruthy();
  });

  // #504-T02
  it("sends the typed credentials, empties the fields and never shows them", async () => {
    const mock = api();
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Stripe API key"), KEY);
    await user.type(screen.getByLabelText("Webhook secret"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({
        stripe: { apiKey: KEY, webhookSecret: SECRET },
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Stripe API key") as HTMLInputElement).value,
      ).toBe(""),
    );
    expect(
      (screen.getByLabelText("Webhook secret") as HTMLInputElement).value,
    ).toBe("");
    expect(document.body.textContent).not.toContain(KEY);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // #504-T02
  it("makes both fields password fields that the browser does not fill in", () => {
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={api()} />);

    for (const label of ["Stripe API key", "Webhook secret"]) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("type")).toBe("password");
      expect(field.getAttribute("autocomplete")).toBe("new-password");
    }
  });

  // #504-T02
  it("says whether each credential is saved, with the last four characters, and whether it can be read", () => {
    render(
      <BillingPage
        billing={{
          ...STRIPE_VIEW,
          stripe: {
            ...STRIPE_VIEW.stripe,
            apiKey: { state: "configured", lastFour: "6789" },
            webhookSecret: { state: "unreadable" },
            environment: "test",
          },
        }}
        notice={NOTICE}
        api={api()}
      />,
    );

    expect(
      screen.getByText(/An API key is saved, ending in 6789\./),
    ).toBeTruthy();
    expect(
      screen.getByText(/The saved webhook secret cannot be read\./),
    ).toBeTruthy();
    expect(screen.getByText(/test mode/)).toBeTruthy();
  });

  // #504-T02
  it("shows the sentence for a key the server refuses, on the field", async () => {
    const mock = api({
      change: () =>
        failure("invalid_input", [
          { field: "apiKey", code: "api_key_invalid" },
        ]),
    });
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Stripe API key"), "pk_test_nope");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    expect(
      await screen.findByText(/This is not a Stripe API key/),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Stripe API key").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  // #504-T05
  it("checks the connection and says which mode Stripe accepted the key for, and has the check off without a key", async () => {
    const mock = api();
    const view = {
      ...STRIPE_VIEW,
      stripe: {
        ...STRIPE_VIEW.stripe,
        apiKey: { state: "configured", lastFour: "6789" } as const,
      },
    };
    const { rerender } = render(
      <BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Check connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    rerender(<BillingPage billing={view} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check connection" }));

    expect(
      await screen.findByText(/Stripe accepted the API key \(test mode\)/),
    ).toBeTruthy();
  });

  // #690-T03
  it("names the HTTP status when the answer to a save is not one of the routes", async () => {
    const mock = api({
      change: () =>
        Promise.resolve({
          ok: false,
          status: 502,
          code: "UNEXPECTED_RESPONSE",
          issues: [],
        }),
    });
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Stripe API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    expect(
      await screen.findByText(/The server answered with HTTP 502\./),
    ).toBeTruthy();
  });

  // #690-T01
  it("shows what Stripe said when a save fails the check", async () => {
    const mock = api({
      change: () =>
        failure("stripe_unavailable", [], {
          stripe: { status: 400, code: null, type: "invalid_request_error" },
        }),
    });
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Stripe API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    expect(
      await screen.findByText(
        /Stripe failed to answer the request\. Try again in a moment\. Stripe said: HTTP 400, invalid_request_error\./,
      ),
    ).toBeTruthy();
  });

  // #690-T04
  it("says the account is not enabled for Managed Payments when the check answers so", async () => {
    const mock = api();
    mock.check.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        data: {
          ok: false,
          error: "stripe_managed_payments_unavailable",
          stripe: { status: 400, code: null, type: "invalid_request_error" },
        },
      }),
    );
    const view = {
      ...STRIPE_VIEW,
      stripe: {
        ...STRIPE_VIEW.stripe,
        apiKey: { state: "configured", lastFour: "6789" } as const,
      },
    };
    render(<BillingPage billing={view} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check connection" }));

    expect(
      await screen.findByText(/not enabled for Managed Payments/),
    ).toBeTruthy();
  });

  // #504-T06
  it("creates the webhook endpoint and tells a taken-over one from a new one", async () => {
    const mock = api();
    const view = {
      ...STRIPE_VIEW,
      stripe: {
        ...STRIPE_VIEW.stripe,
        apiKey: { state: "configured", lastFour: null } as const,
      },
    };
    render(<BillingPage billing={view} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Create webhook endpoint" }));

    expect(
      await screen.findByText(/The webhook endpoint is in place/),
    ).toBeTruthy();
    expect(mock.createWebhookEndpoint).toHaveBeenCalledWith(undefined);
  });

  // #504-T07
  it("has no button to create the endpoint when the address of the app is not public, and says why", () => {
    const view = {
      ...STRIPE_VIEW,
      stripe: {
        ...STRIPE_VIEW.stripe,
        apiKey: { state: "configured", lastFour: null } as const,
        webhookUrl: "http://localhost:3000/api/billing/webhook",
        webhookUrlPublic: false,
      },
    };
    render(<BillingPage billing={view} notice={NOTICE} api={api()} />);

    expect(
      (
        screen.getByRole("button", {
          name: "Create webhook endpoint",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/not a public https address/)).toBeTruthy();
  });

  // #504-T04
  it("keeps the adapter and the replacing of the endpoint off while billing is on, and offers no removal", () => {
    render(
      <BillingPage
        billing={{
          ...STRIPE_VIEW,
          enabled: true,
          on: true,
          missing: [],
          stripe: {
            ...STRIPE_VIEW.stripe,
            apiKey: { state: "configured", lastFour: null },
            webhookSecret: { state: "configured", lastFour: null },
          },
        }}
        notice={NOTICE}
        api={api()}
      />,
    );

    expect(
      (screen.getByRole("radio", { name: /^Manual:/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Replace webhook endpoint",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Remove the API key" }),
    ).toBeNull();
  });

  // #504-T02
  it("removes a saved credential after a confirmation while billing is off", async () => {
    const mock = api();
    render(
      <BillingPage
        billing={{
          ...STRIPE_VIEW,
          stripe: {
            ...STRIPE_VIEW.stripe,
            apiKey: { state: "configured", lastFour: "6789" },
          },
        }}
        notice={NOTICE}
        api={mock}
      />,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: "Remove the API key" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove the API key" }),
    );

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({ removeSecret: "apiKey" }),
    );
  });
});

describe("the rates and numbers", () => {
  // #504-T09
  it("shows A as a decimal and the money in US dollars, and the start credit default of 2", () => {
    render(<BillingPage billing={RATED} notice={NOTICE} api={api()} />);

    expect((screen.getByLabelText("Factor A") as HTMLInputElement).value).toBe(
      "5",
    );
    expect(
      (
        screen.getByLabelText(
          "Rate per started minute, Diff reviews (USD)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.013");
    expect(
      (
        screen.getByLabelText(
          "Rate per started minute, Dynamic reviews (USD)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.016");
    expect(
      (
        screen.getByLabelText(
          "AI reserve per Diff review (USD)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.15");
    expect(
      (screen.getByLabelText("Start credit (USD)") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      (screen.getByLabelText("Low-balance threshold (USD)") as HTMLInputElement)
        .value,
    ).toBe("5");
    expect(
      (
        screen.getByLabelText(
          "Hourly review limit per workspace",
        ) as HTMLInputElement
      ).value,
    ).toBe("60");
  });

  // #504-T09
  it("starts with empty fields for what has no default, and sends only what the admin typed", async () => {
    const mock = api();
    render(<BillingPage billing={VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();
    expect((screen.getByLabelText("Factor A") as HTMLInputElement).value).toBe(
      "",
    );

    await user.type(screen.getByLabelText("Factor A"), "5");
    await user.type(
      screen.getByLabelText("Rate per started minute, Diff reviews (USD)"),
      "0.013",
    );
    await user.type(
      screen.getByLabelText("Rate per started minute, Dynamic reviews (USD)"),
      "0.016",
    );
    await user.type(
      screen.getByLabelText("AI reserve per Diff review (USD)"),
      "0.15",
    );
    await user.click(
      screen.getByRole("button", { name: "Save rates and numbers" }),
    );

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({
        rates: {
          factorA: 50_000,
          minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
          diffAiReserveMicroUsd: 150_000,
        },
      }),
    );
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  // #504-T09
  it("sends a changed start credit of 0 and the brake as whole numbers", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Start credit (USD)"));
    await user.type(screen.getByLabelText("Start credit (USD)"), "0");
    await user.clear(
      screen.getByLabelText("Hourly review limit per workspace"),
    );
    await user.type(
      screen.getByLabelText("Hourly review limit per workspace"),
      "30",
    );
    await user.click(
      screen.getByRole("button", { name: "Save rates and numbers" }),
    );

    await waitFor(() => expect(mock.change).toHaveBeenCalled());
    const [[sent]] = mock.change.mock.calls;
    expect(sent).toEqual({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
        startCreditMicroUsd: 0,
        hourlyReviewLimit: 30,
      },
    });
  });

  // #504-T09
  it("refuses text that is no number before anything is sent, on the field", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Factor A"));
    await user.type(screen.getByLabelText("Factor A"), "five");
    await user.click(
      screen.getByRole("button", { name: "Save rates and numbers" }),
    );

    expect(
      await screen.findByText(/Enter the factor A as a decimal/),
    ).toBeTruthy();
    expect(mock.change).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Factor A").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  // #504-T09
  it("shows the server's refusal on the field it is about", async () => {
    const mock = api({
      change: () =>
        failure("invalid_input", [
          { field: "minuteRateMicroUsd.dynamic", code: "rate_invalid" },
        ]),
    });
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Save rates and numbers" }));

    const field = screen.getByLabelText(
      "Rate per started minute, Dynamic reviews (USD)",
    );
    await waitFor(() =>
      expect(field.getAttribute("aria-invalid")).toBe("true"),
    );
    expect(
      screen
        .getByLabelText("Rate per started minute, Diff reviews (USD)")
        .getAttribute("aria-invalid"),
    ).not.toBe("true");
  });
});

describe("the links to the terms and the privacy statement", () => {
  const LEGAL_VIEW: BillingView = {
    ...RATED,
    legal: {
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
    },
  };

  // #626-T07
  it("shows both links as they are stored, and the terms link as needed for Stripe", () => {
    render(<BillingPage billing={LEGAL_VIEW} notice={NOTICE} api={api()} />);

    const card = screen.getByRole("region", { name: "Terms and privacy" });
    expect(
      (within(card).getByLabelText("Link to the terms") as HTMLInputElement)
        .value,
    ).toBe("https://example.com/terms");
    expect(
      (
        within(card).getByLabelText(
          "Link to the privacy statement (optional)",
        ) as HTMLInputElement
      ).value,
    ).toBe("https://example.com/privacy");
    expect(within(card).getByText(/Needed to run Stripe/)).toBeTruthy();
  });

  // #626-T07
  it("sends the typed links, and an emptied field as an empty text, which removes the link", async () => {
    const mock = api({}, LEGAL_VIEW);
    render(<BillingPage billing={LEGAL_VIEW} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Link to the terms"));
    await user.type(
      screen.getByLabelText("Link to the terms"),
      "https://example.com/terms-2",
    );
    await user.clear(
      screen.getByLabelText("Link to the privacy statement (optional)"),
    );
    await user.click(
      screen.getByRole("button", { name: "Save terms and privacy links" }),
    );

    await waitFor(() =>
      expect(mock.change).toHaveBeenCalledWith({
        legal: { termsUrl: "https://example.com/terms-2", privacyUrl: "" },
      }),
    );
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  // #626-T07
  it("shows the server's refusal on the link it is about", async () => {
    const mock = api({
      change: () =>
        failure("invalid_input", [
          { field: "legal.termsUrl", code: "url_invalid" },
        ]),
    });
    render(<BillingPage billing={LEGAL_VIEW} notice={NOTICE} api={mock} />);

    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Save terms and privacy links" }),
      );

    await waitFor(() =>
      expect(
        screen.getByLabelText("Link to the terms").getAttribute("aria-invalid"),
      ).toBe("true"),
    );
    expect(screen.getByText(/must be an https address/)).toBeTruthy();
    expect(
      screen
        .getByLabelText("Link to the privacy statement (optional)")
        .getAttribute("aria-invalid"),
    ).not.toBe("true");
  });

  // #626-T07
  it("names the terms link among what is missing for Stripe, in words", () => {
    render(<BillingPage billing={STRIPE_VIEW} notice={NOTICE} api={api()} />);

    expect(screen.getByText("The link to your terms")).toBeTruthy();
  });
});

describe("the check of the journal", () => {
  const checked = (
    journalCheck: BillingView["journalCheck"],
    on = true,
  ): BillingView => ({ ...RATED, enabled: on, on, journalCheck });

  // #626-T17
  it("says that no check has run yet, and that it runs daily while billing is on", () => {
    render(<BillingPage billing={RATED} notice={NOTICE} api={api()} />);

    const status = screen.getByRole("region", { name: "Journal check" });
    expect(within(status).getByText(/Journal check: not run yet/)).toBeTruthy();
    expect(
      within(status).getByText(/once a day while billing is on/),
    ).toBeTruthy();
  });

  // #626-T17
  it("shows an ok result with the date", () => {
    render(
      <BillingPage
        billing={checked({
          state: "ok",
          checkedAt: "2026-10-21T03:00:12.000Z",
          workspaces: 12,
          inconsistentWorkspaces: 0,
        })}
        notice={NOTICE}
        api={api()}
      />,
    );

    const status = screen.getByRole("region", { name: "Journal check" });
    expect(
      within(status).getByText("Journal check: ok (2026-10-21 03:00 UTC)"),
    ).toBeTruthy();
    expect(within(status).getByText(/12 workspaces/)).toBeTruthy();
    expect(within(status).queryByRole("alert")).toBeNull();
  });

  // #626-T17
  it("shows an inconsistent result with the date, how many workspaces and where to look", () => {
    render(
      <BillingPage
        billing={checked({
          state: "inconsistent",
          checkedAt: "2026-10-21T03:00:12.000Z",
          workspaces: 12,
          inconsistentWorkspaces: 2,
        })}
        notice={NOTICE}
        api={api()}
      />,
    );

    const status = screen.getByRole("region", { name: "Journal check" });
    expect(
      within(status).getByText(
        "Journal check: inconsistent (2026-10-21 03:00 UTC)",
      ),
    ).toBeTruthy();
    expect(within(status).getByText(/2 of 12 workspaces/)).toBeTruthy();
    expect(
      within(status).getByText(/BILLING_JOURNAL_INCONSISTENT/),
    ).toBeTruthy();
  });

  // #626-T17
  it("says the check is paused while billing is off, and still shows the last result", () => {
    render(
      <BillingPage
        billing={checked(
          {
            state: "ok",
            checkedAt: "2026-10-21T03:00:12.000Z",
            workspaces: 12,
            inconsistentWorkspaces: 0,
          },
          false,
        )}
        notice={NOTICE}
        api={api()}
      />,
    );

    const status = screen.getByRole("region", { name: "Journal check" });
    expect(within(status).getByText(/Journal check: ok/)).toBeTruthy();
    expect(
      within(status).getByText(/paused while billing is off/),
    ).toBeTruthy();
  });
});

describe("the manual credit", () => {
  async function pickWorkspace(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Search workspaces"), "acm");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByRole("button", { name: /Acme/ }));
    await screen.findByText(/has a balance of/);
  }

  // #504-T10
  it("finds a workspace by name and shows its balance and recent entries", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);

    await pickWorkspace(userEvent.setup());

    expect(mock.searchWorkspaces).toHaveBeenCalledWith("acm");
    expect(screen.getByText("8.00 USD")).toBeTruthy();
    expect(screen.getByText("Pilot customer")).toBeTruthy();
    expect(screen.getByText("10.00")).toBeTruthy();
  });

  // #504-T10
  it("writes a credit of 10 with a note and a request id", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();
    await pickWorkspace(user);

    await user.type(screen.getByLabelText("Amount (USD)"), "10");
    await user.type(screen.getByLabelText("Note"), "Pilot customer");
    await user.click(screen.getByRole("button", { name: "Write credit" }));

    await waitFor(() => expect(mock.credit).toHaveBeenCalled());
    const [id, input] = mock.credit.mock.calls[0] ?? [];
    expect(id).toBe("ws-1");
    expect(input).toMatchObject({
      type: "credit",
      amountMicroUsd: 10_000_000,
      note: "Pilot customer",
    });
    expect(input?.requestId).toMatch(/\S{8,}/);
    expect(
      await screen.findByText("The credit is written to the journal."),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Amount (USD)") as HTMLInputElement).value,
    ).toBe("");
  });

  // #504-T10
  it("writes a correction of -2", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();
    await pickWorkspace(user);

    await user.click(screen.getByRole("radio", { name: /A correction/ }));
    await user.type(screen.getByLabelText("Amount (USD)"), "-2");
    await user.type(screen.getByLabelText("Note"), "Refunded outside Stripe");
    await user.click(screen.getByRole("button", { name: "Write correction" }));

    await waitFor(() => expect(mock.credit).toHaveBeenCalled());
    expect(mock.credit.mock.calls[0]?.[1]).toMatchObject({
      type: "correction",
      amountMicroUsd: -2_000_000,
      note: "Refunded outside Stripe",
    });
  });

  // #504-T10
  it("shows the refusal of a credit without a note on the note field", async () => {
    const mock = api();
    mock.credit.mockImplementation(
      () =>
        failure("invalid_input", [
          { field: "note", code: "note_required" },
        ]) as never,
    );
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();
    await pickWorkspace(user);

    await user.type(screen.getByLabelText("Amount (USD)"), "10");
    await user.click(screen.getByRole("button", { name: "Write credit" }));

    expect(await screen.findByText(/Write a note that says why/)).toBeTruthy();
    expect(screen.getByLabelText("Note").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  // #504-T10
  it("refuses an amount that is no number before anything is sent", async () => {
    const mock = api();
    render(<BillingPage billing={RATED} notice={NOTICE} api={mock} />);
    const user = userEvent.setup();
    await pickWorkspace(user);

    await user.type(screen.getByLabelText("Amount (USD)"), "ten");
    await user.type(screen.getByLabelText("Note"), "x");
    await user.click(screen.getByRole("button", { name: "Write credit" }));

    expect(
      await screen.findByText(/Enter an amount in US dollars/),
    ).toBeTruthy();
    expect(mock.credit).not.toHaveBeenCalled();
  });
});
