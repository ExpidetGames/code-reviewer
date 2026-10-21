// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the page of the billing review rows (#603): what a row shows so an operator can act on it (the outcome in plain
// words, the Stripe object, the workspace and the top-up of ours where known, when it arrived), closing it with a required
// note, the manual credit prefilled from the row, "Check payment", and the resolved rows with how they were closed. The server
// judges every value; the page shows the reason it gets back.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { BillingReviewApi } from "./billing-review-api.ts";
import { BillingReviewsPage } from "./billing-reviews-page.tsx";
import type {
  BillingReviewListView,
  BillingReviewView,
} from "./billing-review-view.ts";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(cleanup);

const REFUSED: BillingReviewView = {
  provider: "stripe",
  eventId: "evt_refused",
  outcome: "amount_rejected",
  subject: { kind: "payment", ref: "pi_123" },
  workspace: { id: "ws-1", name: "Acme", slug: "acme" },
  intent: {
    id: "intent-1",
    state: "pending",
    amountMicroUsd: 25_000_000,
    checkoutRef: "cs_test_abc",
    paymentRef: null,
  },
  receivedAt: "2026-10-21T08:00:00.000Z",
  state: "open",
  resolution: null,
  suggestion: { type: "credit", amountMicroUsd: 25_000_000 },
};

const FOREIGN: BillingReviewView = {
  provider: "stripe",
  eventId: "evt_foreign",
  outcome: "intent_unresolved",
  subject: { kind: "refund", ref: "re_9" },
  workspace: null,
  intent: null,
  receivedAt: "2026-10-21T09:00:00.000Z",
  state: "open",
  resolution: null,
  suggestion: null,
};

const CLOSED: BillingReviewView = {
  ...REFUSED,
  eventId: "evt_closed",
  state: "resolved",
  suggestion: { type: "credit", amountMicroUsd: 25_000_000 },
  resolution: {
    at: "2026-10-21T12:00:00.000Z",
    byName: "Ada Admin",
    note: "Credited 12.50 after the coupon",
    entryId: "entry-7",
  },
};

function list(
  rows: BillingReviewView[],
  overrides: Partial<BillingReviewListView> = {},
): BillingReviewListView {
  return {
    state: "open",
    page: 1,
    pageSize: 25,
    total: rows.length,
    openTotal: rows.length,
    rows,
    ...overrides,
  };
}

function ok<T>(data: T): RequestResult<T> {
  return { ok: true, data };
}

function failed(code: string, issues = []): RequestResult<never> {
  return { ok: false, status: 422, code, issues };
}

type MockApi = {
  [K in keyof BillingReviewApi]: Mock<BillingReviewApi[K]>;
};

function mockApi(): MockApi {
  return {
    resolve: vi.fn<BillingReviewApi["resolve"]>(() =>
      Promise.resolve(ok({ ok: true as const, review: CLOSED })),
    ),
    check: vi.fn<BillingReviewApi["check"]>(() =>
      Promise.resolve(
        ok({ ok: true as const, intentState: "paid", review: REFUSED }),
      ),
    ),
  };
}

function renderPage(
  view: BillingReviewListView,
  api: MockApi = mockApi(),
): MockApi {
  render(<BillingReviewsPage list={view} api={api} />);
  return api;
}

function rowOf(eventId: string): HTMLElement {
  return screen.getByRole("listitem", { name: new RegExp(eventId) });
}

describe("the billing review rows", () => {
  // #603-T01
  it("show the outcome in plain words, the Stripe object, the workspace, the top-up of ours and when it arrived", () => {
    renderPage(list([REFUSED]));

    const row = within(rowOf("evt_refused"));
    expect(row.getByText(/refused because its amount/i)).toBeTruthy();
    expect(row.getByText("Payment pi_123")).toBeTruthy();
    expect(row.getByText(/Acme/)).toBeTruthy();
    expect(row.getByText(/acme/)).toBeTruthy();
    expect(row.getByText(/intent-1/)).toBeTruthy();
    expect(row.getByText(/25\.00 USD asked/)).toBeTruthy();
    expect(row.getByText("cs_test_abc")).toBeTruthy();
    expect(row.getByText(/2026-10-21/)).toBeTruthy();
  });

  // #603-T04
  it("say that nobody is known for a payment that is none of ours and offer no credit", () => {
    renderPage(list([FOREIGN]));

    const row = within(rowOf("evt_foreign"));
    expect(row.getByText("Refund re_9")).toBeTruthy();
    expect(row.getByText(/No workspace of this instance/)).toBeTruthy();
    expect(row.queryByRole("button", { name: /Credit/ })).toBeNull();
    expect(row.queryByRole("button", { name: "Check payment" })).toBeNull();
    expect(
      row.getByRole("button", { name: "Close without a credit" }),
    ).toBeTruthy();
  });

  // #603-T02
  it("close with the note and no credit, and say that no money moved", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));

    const row = within(rowOf("evt_refused"));
    await user.type(row.getByLabelText("Note"), "Refunded at Stripe by hand");
    await user.click(
      row.getByRole("button", { name: "Close without a credit" }),
    );

    await waitFor(() => expect(api.resolve).toHaveBeenCalled());
    expect(api.resolve.mock.calls[0]?.[0]).toEqual({
      provider: "stripe",
      eventId: "evt_refused",
      note: "Refunded at Stripe by hand",
    });
    expect(
      await screen.findByText("The row is closed. No money moved."),
    ).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #603-T08
  it("show the refusal of a close without a note on the note field", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));
    api.resolve.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "invalid_input",
      issues: [{ field: "note", code: "note_required" }],
    });

    const row = within(rowOf("evt_refused"));
    await user.click(
      row.getByRole("button", { name: "Close without a credit" }),
    );

    expect(
      await row.findByText(
        "Write a note that says why: it stays in the journal.",
      ),
    ).toBeTruthy();
  });

  // #603-T09
  it("prefill the credit with the amount we asked for, and send the amount typed with the note", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));

    const row = within(rowOf("evt_refused"));
    const amount = row.getByLabelText("Amount (USD)") as HTMLInputElement;
    expect(amount.value).toBe("25.00");
    await user.clear(amount);
    await user.type(amount, "12.5");
    await user.type(row.getByLabelText("Note"), "Paid 12.50 after a coupon");
    await user.click(
      row.getByRole("button", { name: "Credit the workspace and close" }),
    );

    await waitFor(() => expect(api.resolve).toHaveBeenCalled());
    expect(api.resolve.mock.calls[0]?.[0]).toEqual({
      provider: "stripe",
      eventId: "evt_refused",
      note: "Paid 12.50 after a coupon",
      credit: { type: "credit", amountMicroUsd: 12_500_000 },
    });
    expect(
      await screen.findByText(
        "The workspace is credited and the row is closed.",
      ),
    ).toBeTruthy();
  });

  // #603-T15
  it("ask for an amount to correct with, signed, where the application cannot know it", async () => {
    const user = userEvent.setup();
    const api = renderPage(
      list([
        {
          ...FOREIGN,
          workspace: { id: "ws-1", name: "Acme", slug: "acme" },
          suggestion: { type: "correction", amountMicroUsd: null },
        },
      ]),
    );

    const row = within(rowOf("evt_foreign"));
    const amount = row.getByLabelText("Amount (USD)") as HTMLInputElement;
    expect(amount.value).toBe("");
    await user.type(amount, "-5");
    await user.type(row.getByLabelText("Note"), "Refunded before the credit");
    await user.click(
      row.getByRole("button", { name: "Correct the balance and close" }),
    );

    await waitFor(() => expect(api.resolve).toHaveBeenCalled());
    expect(api.resolve.mock.calls[0]?.[0]).toMatchObject({
      credit: { type: "correction", amountMicroUsd: -5_000_000 },
    });
  });

  // #603-T13
  it("refuses an amount that is no amount before it asks the server", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));

    const row = within(rowOf("evt_refused"));
    const amount = row.getByLabelText("Amount (USD)");
    await user.clear(amount);
    await user.type(amount, "abc");
    await user.type(row.getByLabelText("Note"), "n");
    await user.click(
      row.getByRole("button", { name: "Credit the workspace and close" }),
    );

    expect(
      await row.findByText(
        "Enter an amount in US dollars. A credit is more than 0; a correction is not 0.",
      ),
    ).toBeTruthy();
    expect(api.resolve).not.toHaveBeenCalled();
  });

  // #603-T10
  it("explain a retry with another amount in words", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));
    api.resolve.mockResolvedValueOnce(failed("request_conflict"));

    const row = within(rowOf("evt_refused"));
    await user.type(row.getByLabelText("Note"), "n");
    await user.click(
      row.getByRole("button", { name: "Credit the workspace and close" }),
    );

    expect(
      await row.findByText(/already made with another amount/),
    ).toBeTruthy();
  });

  // #603-T16
  it("check the payment of the row and report the state of the top-up", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));

    await user.click(
      within(rowOf("evt_refused")).getByRole("button", {
        name: "Check payment",
      }),
    );

    await waitFor(() => expect(api.check).toHaveBeenCalled());
    expect(api.check.mock.calls[0]?.[0]).toEqual({
      provider: "stripe",
      eventId: "evt_refused",
    });
    expect(
      await screen.findByText(/Stripe says the top-up is paid/),
    ).toBeTruthy();
  });

  // #603-T16
  it("say so when the provider could not be asked", async () => {
    const user = userEvent.setup();
    const api = renderPage(list([REFUSED]));
    api.check.mockResolvedValueOnce(failed("payment_check_unavailable"));

    await user.click(
      within(rowOf("evt_refused")).getByRole("button", {
        name: "Check payment",
      }),
    );

    expect(await screen.findByText(/could not be asked/)).toBeTruthy();
  });
});

describe("the resolved rows", () => {
  // #603-T02
  it("show how a row was closed, by whom, with which note and which journal entry, and offer no action", () => {
    renderPage(list([CLOSED], { state: "resolved" }));

    const row = within(rowOf("evt_closed"));
    expect(row.getByText(/Ada Admin/)).toBeTruthy();
    expect(row.getByText("Credited 12.50 after the coupon")).toBeTruthy();
    expect(row.getByText(/entry-7/)).toBeTruthy();
    expect(row.queryByRole("button")).toBeNull();
  });
});

describe("the list", () => {
  // #603-T07
  it("links the two states with the number of open rows, and marks the one shown", () => {
    renderPage(list([REFUSED], { openTotal: 3 }));

    const open = screen.getByRole("link", { name: /^Open/ });
    const resolved = screen.getByRole("link", { name: "Resolved" });
    expect(open.textContent).toContain("3");
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.getAttribute("href")).toBe("/admin/billing/reviews");
    expect(resolved.getAttribute("href")).toBe(
      "/admin/billing/reviews?state=resolved",
    );
  });

  // #603-T07
  it("pages with links that keep the state", () => {
    renderPage(
      list([REFUSED], { state: "resolved", page: 2, total: 60, pageSize: 25 }),
    );

    expect(
      screen.getByRole("link", { name: "Previous page" }).getAttribute("href"),
    ).toBe("/admin/billing/reviews?state=resolved");
    expect(
      screen.getByRole("link", { name: "Next page" }).getAttribute("href"),
    ).toBe("/admin/billing/reviews?state=resolved&page=3");
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
  });

  // #603-T07
  it("says so when nothing is open", () => {
    renderPage(list([], { openTotal: 0 }));

    expect(screen.getByText("No payment needs a review.")).toBeTruthy();
  });
});
