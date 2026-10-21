// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// #505: the billing page of a workspace. What a person sees of the balance and why reviews are paused, the top-up with its
// billing details and its business confirmation, a payment that is on its way and "Check payment", the journal with the price of
// each review, the monthly limit, and what a Member does not get. The server judges every value; the page shows the reason it
// gets back. Final prices only: no rate, no minute count, no formula, no brake.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { WorkspaceBillingApi } from "../api.ts";
import type { WorkspaceBillingView } from "../view.ts";
import { BillingPageContent } from "./billing-page.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const USD = 1_000_000;

const PROFILE = {
  legalName: "Acme GmbH",
  country: "DE",
  addressLine1: "Hauptstrasse 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  vatId: null,
  businessConfirmed: false,
};

const OWNER_VIEW: WorkspaceBillingView = {
  canManage: true,
  balanceMicroUsd: 8_500_000,
  heldMicroUsd: 0,
  state: "ok",
  topUpAvailable: true,
  profileRequired: true,
  pendingTopUps: [],
  profile: PROFILE,
  monthlyLimitCents: null,
  chargedThisMonthMicroUsd: 1_250_000,
  keyMode: "managed",
  journal: {
    rows: [
      {
        id: "e3",
        kind: "usage",
        amountMicroUsd: -1_630_000,
        createdAt: "2026-10-12T09:30:00.000Z",
        run: { id: "run-1", label: "acme/widgets #7" },
        aiMicroUsd: 1_500_000,
        infraMicroUsd: 130_000,
      },
      {
        id: "e2",
        kind: "usage",
        amountMicroUsd: -260_000,
        createdAt: "2026-10-12T08:30:00.000Z",
        run: { id: "run-2", label: "acme/widgets #8" },
        aiMicroUsd: null,
        infraMicroUsd: 260_000,
      },
      {
        id: "e1",
        kind: "top_up",
        amountMicroUsd: 10 * USD,
        createdAt: "2026-10-11T08:00:00.000Z",
        run: null,
        aiMicroUsd: null,
        infraMicroUsd: null,
      },
    ],
    next: null,
  },
};

const MEMBER_VIEW: WorkspaceBillingView = {
  ...OWNER_VIEW,
  canManage: false,
  pendingTopUps: [],
  profile: null,
  monthlyLimitCents: null,
  chargedThisMonthMicroUsd: null,
};

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (
  code: string,
  issues: Array<{ field: string; code: string }> = [],
): RequestResult<never> => ({ ok: false, status: 422, code, issues });

function fakeApi(overrides: Partial<WorkspaceBillingApi> = {}) {
  const api = {
    saveProfile: vi.fn(() => Promise.resolve(ok({ profile: PROFILE }))),
    startTopUp: vi.fn(() =>
      Promise.resolve(
        ok({ intentId: "intent-1", url: "https://pay.example.test/c/1" }),
      ),
    ),
    checkPayment: vi.fn(() =>
      Promise.resolve(ok({ intentId: "p1", state: "paid" })),
    ),
    setMonthlyLimit: vi.fn((cents: number | null) =>
      Promise.resolve(ok({ monthlyLimitCents: cents })),
    ),
    journal: vi.fn(() =>
      Promise.resolve(ok({ rows: [], next: null as string | null })),
    ),
    ...overrides,
  };
  return api as typeof api & WorkspaceBillingApi;
}

function page(
  view: WorkspaceBillingView,
  options: {
    api?: WorkspaceBillingApi;
    navigate?: (url: string) => void;
    returned?: "success" | "cancelled" | null;
    termsHref?: string | null;
    privacyHref?: string | null;
  } = {},
) {
  const api = options.api ?? fakeApi();
  const navigate = options.navigate ?? vi.fn();
  const utils = render(
    <BillingPageContent
      workspaceSlug="acme"
      view={view}
      returned={options.returned ?? null}
      termsHref={options.termsHref ?? null}
      privacyHref={options.privacyHref ?? null}
      api={api}
      navigate={navigate}
    />,
  );
  return { ...utils, api, navigate };
}

beforeEach(() => {
  navigation.refresh.mockClear();
});

describe("the balance", () => {
  // #505-T01
  it("shows the balance in dollars and the hint that credit never expires", () => {
    page(OWNER_VIEW);

    const balance = screen.getByRole("region", { name: "Balance" });
    expect(within(balance).getByText("$8.50")).toBeTruthy();
    expect(within(balance).getByText(/never expires/)).toBeTruthy();
    expect(within(balance).queryByText(/Held by running reviews/)).toBeNull();
  });

  // #505-T01
  it("shows what running reviews hold separately, when something is held", () => {
    page({ ...OWNER_VIEW, heldMicroUsd: 2 * USD });

    const balance = screen.getByRole("region", { name: "Balance" });
    expect(within(balance).getByText(/Held by running reviews/)).toBeTruthy();
    expect(within(balance).getByText("$2.00")).toBeTruthy();
  });

  // #505-T08
  it("explains an empty balance and the way out to an Owner", () => {
    page({ ...OWNER_VIEW, balanceMicroUsd: 0, state: "empty" });

    const note = screen.getByRole("alert");
    expect(note.textContent).toContain("No credit left");
    expect(note.textContent).toContain("New reviews are not started");
    expect(note.textContent).toContain("Add credit below");
  });

  // #505-T08
  it("explains a negative balance, that a review that ended took it below zero, and who can fix it for a Member", () => {
    page({ ...MEMBER_VIEW, balanceMicroUsd: -500_000, state: "negative" });

    const note = screen.getByRole("alert");
    expect(note.textContent).toContain("The balance is below zero");
    expect(note.textContent).toContain("until it is above zero again");
    expect(note.textContent).toContain("Ask an Owner or Admin");
    expect(screen.getByText("-$0.50")).toBeTruthy();
  });

  // #505-T01
  it("shows no warning while the balance is positive", () => {
    page(OWNER_VIEW);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("what a Member sees", () => {
  // #505-T02
  it("is the balance and the journal, read-only, with no top-up, no billing details and no limit", () => {
    page(MEMBER_VIEW);

    expect(screen.getByRole("region", { name: "Balance" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Journal" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Add credit" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Billing details" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Monthly spending limit" }),
    ).toBeNull();
    expect(
      screen.getByText(/You can see the balance and the journal/),
    ).toBeTruthy();
  });
});

describe("the manual adapter", () => {
  // #505-T10
  it("shows no form and asks the person to ask the operator", () => {
    page({
      ...OWNER_VIEW,
      topUpAvailable: false,
      profileRequired: false,
      profile: null,
    });

    const card = screen.getByRole("region", { name: "Add credit" });
    expect(card.textContent).toContain("Ask your operator to add credit");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Billing details" }),
    ).toBeNull();
  });
});

describe("the top-up", () => {
  async function fillProfile(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Legal name"), "Acme GmbH");
    await user.type(screen.getByLabelText(/^Country/), "DE");
    await user.type(screen.getByLabelText("Address"), "Hauptstrasse 1");
    await user.type(screen.getByLabelText("Postal code"), "10115");
    await user.type(screen.getByLabelText("City"), "Berlin");
  }

  // #505-T03
  it("saves the billing details, starts the payment with the business confirmation and goes to the payment page", async () => {
    const user = userEvent.setup();
    const { api } = page({ ...OWNER_VIEW, profile: null });

    await fillProfile(user);
    await user.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1));
    expect(api.saveProfile).toHaveBeenCalledWith({
      legalName: "Acme GmbH",
      country: "DE",
      addressLine1: "Hauptstrasse 1",
      addressLine2: null,
      postalCode: "10115",
      city: "Berlin",
      vatId: null,
    });
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #505-T03
  it("pays a preset amount: it needs the business box at the first top-up and sends integer cents", async () => {
    const user = userEvent.setup();
    const { api, navigate } = page(OWNER_VIEW);

    await user.click(screen.getByRole("radio", { name: "$25" }));
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    expect(api.startTopUp).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Confirm that you are buying for a business to continue.",
      ),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("checkbox", { name: /buying for a business/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://pay.example.test/c/1"),
    );
    expect(api.startTopUp).toHaveBeenCalledWith({
      amountCents: 2_500,
      confirmBusiness: true,
      intentId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string,
    });
  });

  // #626-T08
  it("links the terms and the privacy statement in the business confirmation, in a new tab", () => {
    page(OWNER_VIEW, {
      termsHref: "https://example.com/terms",
      privacyHref: "https://example.com/privacy",
    });

    const terms = screen.getByRole("link", { name: "Terms" });
    const privacy = screen.getByRole("link", { name: "Privacy" });
    expect(terms.getAttribute("href")).toBe("https://example.com/terms");
    expect(privacy.getAttribute("href")).toBe("https://example.com/privacy");
    for (const link of [terms, privacy]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  // #626-T08
  it("links only what the instance has set, and nothing when it has set nothing", () => {
    const first = page(OWNER_VIEW, { termsHref: "https://example.com/terms" });

    expect(screen.getByRole("link", { name: "Terms" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Privacy" })).toBeNull();

    first.unmount();
    page(OWNER_VIEW);

    expect(screen.queryByRole("link", { name: "Terms" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Privacy" })).toBeNull();
  });

  // #626-T08
  it("shows no link once the business confirmation was given, as it shows no box then", () => {
    page(
      { ...OWNER_VIEW, profile: { ...PROFILE, businessConfirmed: true } },
      {
        termsHref: "https://example.com/terms",
        privacyHref: "https://example.com/privacy",
      },
    );

    expect(screen.queryByRole("link", { name: "Terms" })).toBeNull();
  });

  // #505-T03
  it("does not ask for the business confirmation again once it was given", async () => {
    const user = userEvent.setup();
    const { api, navigate } = page({
      ...OWNER_VIEW,
      profile: { ...PROFILE, businessConfirmed: true },
    });

    expect(
      screen.queryByRole("checkbox", { name: /buying for a business/ }),
    ).toBeNull();
    await user.click(screen.getByRole("radio", { name: "$100" }));
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.startTopUp).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000, confirmBusiness: false }),
    );
  });

  // #505-T03
  it("takes another amount from $10 to $500 and refuses anything else before it asks the server", async () => {
    const user = userEvent.setup();
    const { api } = page({
      ...OWNER_VIEW,
      profile: { ...PROFILE, businessConfirmed: true },
    });
    const custom = screen.getByLabelText("Other amount (USD)");

    await user.type(custom, "9.99");
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    expect(screen.getByText("Enter an amount from $10 to $500.")).toBeTruthy();
    await user.clear(custom);
    await user.type(custom, "twelve");
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    expect(
      screen.getByText(
        "Enter an amount in US dollars, for example 25 or 25.50.",
      ),
    ).toBeTruthy();
    expect(api.startTopUp).not.toHaveBeenCalled();

    await user.clear(custom);
    await user.type(custom, "37.50");
    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );
    await waitFor(() =>
      expect(api.startTopUp).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 3_750 }),
      ),
    );
  });

  // #505-T03
  it("says why the payment was refused, with the sentence of the code, and goes nowhere", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      startTopUp: vi.fn(() => Promise.resolve(refused("provider_unavailable"))),
    });
    const { navigate } = page(
      { ...OWNER_VIEW, profile: { ...PROFILE, businessConfirmed: true } },
      { api },
    );

    await user.click(
      screen.getByRole("button", { name: "Continue to payment" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "The payment provider could not be reached. Try again in a moment.",
        ),
      ).toBeTruthy(),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  // #505-T03
  it("asks for the billing details before a payment can start", () => {
    page({ ...OWNER_VIEW, profile: null });

    const card = screen.getByRole("region", { name: "Add credit" });
    expect(card.textContent).toContain("Save your billing details first");
    expect(
      (
        within(card).getByRole("button", {
          name: "Continue to payment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #505-T03
  it("shows the field and the sentence of a refused billing detail and keeps what was typed", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      saveProfile: vi.fn(() =>
        Promise.resolve(
          refused("invalid_input", [
            { field: "vatId", code: "vat_id_invalid" },
          ]),
        ),
      ),
    });
    page({ ...OWNER_VIEW, profile: null }, { api });
    await fillProfile(user);
    await user.type(screen.getByLabelText("VAT ID (optional)"), "DE12");

    await user.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("This does not look like a VAT ID of that country."),
      ).toBeTruthy(),
    );
    expect(
      (screen.getByLabelText("VAT ID (optional)") as HTMLInputElement).value,
    ).toBe("DE12");
  });

  // #505-T03
  it("fills the billing details form from the saved profile and sends an empty optional field as nothing", async () => {
    const user = userEvent.setup();
    const { api } = page({
      ...OWNER_VIEW,
      profile: { ...PROFILE, vatId: "DE123456789" },
    });

    expect(
      (screen.getByLabelText("Legal name") as HTMLInputElement).value,
    ).toBe("Acme GmbH");
    await user.clear(screen.getByLabelText("VAT ID (optional)"));
    await user.click(
      screen.getByRole("button", { name: "Save billing details" }),
    );

    await waitFor(() => expect(api.saveProfile).toHaveBeenCalled());
    expect(api.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ vatId: null, addressLine2: null }),
    );
  });
});

describe("a payment on its way", () => {
  const PENDING = {
    id: "p1",
    amountMicroUsd: 25 * USD,
    createdAt: "2026-10-12T09:00:00.000Z",
    canCheck: true,
  };

  // #505-T04
  it("lists a pending payment and checks it on request, then refreshes the balance", async () => {
    const user = userEvent.setup();
    const { api } = page({ ...OWNER_VIEW, pendingTopUps: [PENDING] });

    const list = screen.getByRole("region", { name: "Payments on their way" });
    expect(within(list).getByText("$25.00")).toBeTruthy();
    await user.click(
      within(list).getByRole("button", { name: "Check payment" }),
    );

    await waitFor(() => expect(api.checkPayment).toHaveBeenCalledWith("p1"));
    expect(
      await screen.findByText("The payment arrived and the credit is added."),
    ).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #505-T04
  it("says the payment is still open when the provider has not confirmed it", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      checkPayment: vi.fn(() =>
        Promise.resolve(ok({ intentId: "p1", state: "pending" })),
      ),
    });
    page({ ...OWNER_VIEW, pendingTopUps: [PENDING] }, { api });

    await user.click(screen.getByRole("button", { name: "Check payment" }));

    expect(
      await screen.findByText(
        "The payment has not been confirmed yet. Check again in a moment.",
      ),
    ).toBeTruthy();
  });

  // #505-T04
  it("offers no check for a payment that has no payment page yet", () => {
    page({ ...OWNER_VIEW, pendingTopUps: [{ ...PENDING, canCheck: false }] });

    expect(screen.queryByRole("button", { name: "Check payment" })).toBeNull();
  });

  // #505-T03
  it("says the payment is on its way after the person comes back, and looks again for the credit until it arrives", async () => {
    vi.useFakeTimers();
    page({ ...OWNER_VIEW, pendingTopUps: [PENDING] }, { returned: "success" });

    expect(screen.getByText(/Your payment is on its way/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #505-T03
  it("says nothing was charged after a cancelled payment, and does not poll", async () => {
    vi.useFakeTimers();
    page(OWNER_VIEW, { returned: "cancelled" });

    expect(
      screen.getByText("The payment was cancelled. Nothing was charged."),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(navigation.refresh).not.toHaveBeenCalled();
  });
});

describe("the journal", () => {
  // #505-T01
  it("lists the entries newest first with their signs, and a review with its two prices and a link to its run", () => {
    page(OWNER_VIEW);

    const journal = screen.getByRole("region", { name: "Journal" });
    const rows = within(journal).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("-$1.63")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("$1.50")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("$0.13")).toBeTruthy();
    const link = within(rows[0] as HTMLElement).getByRole("link", {
      name: "acme/widgets #7",
    });
    expect(link.getAttribute("href")).toBe("/w/acme/runs/run-1");
    expect(
      within(rows[2] as HTMLElement).getByText("Credit added"),
    ).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("+$10.00")).toBeTruthy();
  });

  // #505-T07
  it("shows only the infrastructure price of a review on the workspace's own key", () => {
    page(OWNER_VIEW);

    const rows = within(screen.getByRole("region", { name: "Journal" }))
      .getAllByRole("row")
      .slice(1);
    const own = rows[1] as HTMLElement;
    expect(within(own).getByText("Infrastructure")).toBeTruthy();
    expect(within(own).queryByText("AI")).toBeNull();
    expect(
      within(own).getByText("$0.26", { selector: "span.tabular-nums" }),
    ).toBeTruthy();
  });

  // #505-T01
  it("says nothing was booked yet for an empty journal", () => {
    page({ ...OWNER_VIEW, journal: { rows: [], next: null } });

    expect(screen.getByText("Nothing has been booked yet.")).toBeTruthy();
  });

  // #505-T01
  it("loads the next page by its cursor and appends it", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      journal: vi.fn(() =>
        Promise.resolve(
          ok({
            rows: [
              {
                id: "e0",
                kind: "start_credit" as const,
                amountMicroUsd: 2 * USD,
                createdAt: "2026-10-10T08:00:00.000Z",
                run: null,
                aiMicroUsd: null,
                infraMicroUsd: null,
              },
            ],
            next: null,
          }),
        ),
      ),
    });
    page(
      { ...OWNER_VIEW, journal: { ...OWNER_VIEW.journal, next: "41" } },
      { api },
    );

    await user.click(
      screen.getByRole("button", { name: "Show older entries" }),
    );

    await waitFor(() => expect(api.journal).toHaveBeenCalledWith("41"));
    expect(await screen.findByText("Start credit")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Show older entries" }),
    ).toBeNull();
  });

  // #505-T01
  it("keeps the rows and says why when the next page cannot be loaded", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      journal: vi.fn(() => Promise.resolve(refused("journal_query_invalid"))),
    });
    page(
      { ...OWNER_VIEW, journal: { ...OWNER_VIEW.journal, next: "41" } },
      { api },
    );

    await user.click(
      screen.getByRole("button", { name: "Show older entries" }),
    );

    expect(
      await screen.findByText(
        "The journal could not be loaded. Reload the page.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Credit added")).toBeTruthy();
  });
});

describe("the monthly limit", () => {
  // #505-T09
  it("sets a limit in whole cents and says it was saved", async () => {
    const user = userEvent.setup();
    const { api } = page(OWNER_VIEW);

    await user.type(screen.getByLabelText(/^Monthly limit/), "250");
    await user.click(screen.getByRole("button", { name: "Save limit" }));

    await waitFor(() =>
      expect(api.setMonthlyLimit).toHaveBeenCalledWith(25_000),
    );
    expect(await screen.findByText("Limit saved.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #505-T09
  it("removes the limit when the field is emptied", async () => {
    const user = userEvent.setup();
    const { api } = page({ ...OWNER_VIEW, monthlyLimitCents: 25_000 });
    const field = screen.getByLabelText(/^Monthly limit/) as HTMLInputElement;
    expect(field.value).toBe("250");

    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save limit" }));

    await waitFor(() => expect(api.setMonthlyLimit).toHaveBeenCalledWith(null));
    expect(await screen.findByText("Limit removed.")).toBeTruthy();
  });

  // #505-T09
  it("refuses a limit outside $1 to $1,000,000 and text before it asks the server", async () => {
    const user = userEvent.setup();
    const { api } = page(OWNER_VIEW);
    const field = screen.getByLabelText(/^Monthly limit/);

    await user.type(field, "0.50");
    await user.click(screen.getByRole("button", { name: "Save limit" }));
    expect(
      screen.getByText("Enter an amount from $1 to $1,000,000."),
    ).toBeTruthy();
    await user.clear(field);
    await user.type(field, "lots");
    await user.click(screen.getByRole("button", { name: "Save limit" }));
    expect(api.setMonthlyLimit).not.toHaveBeenCalled();
  });

  // #505-T09
  it("states what counts toward the limit and that running reviews finish, and shows this month's charges", () => {
    page(OWNER_VIEW);

    const card = screen.getByRole("region", { name: "Monthly spending limit" });
    expect(card.textContent).toContain(
      "Reviews that are already running always finish",
    );
    expect(card.textContent).toContain("$1.25");
  });
});

describe("what the page never says", () => {
  // #505-T06
  it("names no rate, minute count, formula, brake, provider or model id on any of its states", () => {
    const states: WorkspaceBillingView[] = [
      OWNER_VIEW,
      MEMBER_VIEW,
      { ...OWNER_VIEW, state: "empty", balanceMicroUsd: 0 },
      { ...OWNER_VIEW, state: "negative", balanceMicroUsd: -1 },
      { ...OWNER_VIEW, topUpAvailable: false, profile: null },
      { ...OWNER_VIEW, keyMode: "own" },
      { ...OWNER_VIEW, keyMode: "none" },
    ];
    for (const view of states) {
      const { container, unmount } = page(view);
      const text = container.textContent;
      expect(text).not.toMatch(
        /\brates?\b|\bminutes?\b|\bformula\b|\bfactor\b|\bhourly\b|\bbrake\b|\bstripe\b|openrouter|anthropic|openai|[a-z0-9-]+\/[a-z0-9][a-z0-9._:-]*-[a-z0-9]/i,
      );
      unmount();
    }
  });
});

describe("the key and the invoices", () => {
  // #505-T01
  it("names the key mode and links to the LLM access page", () => {
    page({ ...OWNER_VIEW, keyMode: "own" });

    expect(screen.getByText(/infrastructure price only/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Choose the key on the LLM access page" })
        .getAttribute("href"),
    ).toBe("/w/acme/settings/llm");
  });

  // #505-T01
  it("says who issues the invoices, links to link.com and promises nothing about VAT", () => {
    const { container } = page(OWNER_VIEW);

    expect(
      screen.getByText(/Invoices and receipts are issued and emailed by Link/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "link.com" }).getAttribute("href"),
    ).toBe("https://link.com");
    expect(container.textContent).not.toMatch(/VAT-compliant|tax invoice/i);
  });
});
