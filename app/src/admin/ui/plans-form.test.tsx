// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the plans page (#438): the plans in display order, what a change sends, the confirmation before a change
// creates a version (it says which version and that subscribers keep theirs), the key mode of a plan (an own plan hides the
// model list and the operator cost limit and starts unlimited), the Popular move that names the plan losing the badge, the
// Free plan that has no price and no key mode to choose, and the copy for a refusal. Numbers are made up.
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
  NewPlanBody,
  PlanChange,
  PlansApi,
  PlansWriteAnswer,
} from "./plans-api.ts";
import { PlansForm } from "./plans-form.tsx";
import { describePlanFailure } from "./plans-messages.ts";
import type {
  PlanVersionView,
  PlanView,
  PlansView,
  PriceLinkView,
} from "./plans-view.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";

afterEach(cleanup);

// The codes the link of a price can answer with (src/billing/price-errors.ts, server code the page cannot import).
const PRICE_CODES = [
  "price_not_found",
  "price_not_active",
  "price_not_recurring",
  "price_amount_mismatch",
  "price_interval_mismatch",
  "price_currency_mismatch",
  "price_tax_mode_mismatch",
  "price_has_overrides",
  "price_quantity_unsupported",
  "price_product_mismatch",
  "price_environment_mismatch",
  "price_yearly_not_entered",
  "price_input_invalid",
  "price_id_invalid",
  "price_used_by_other_plan",
  "price_plan_not_paid",
  "price_link_not_clearable",
  "price_link_changed",
  "api_key_missing",
  "api_key_unreadable",
  "paddle_key_rejected",
  "paddle_rate_limited",
  "paddle_unreachable",
  "paddle_unavailable",
];

const LIMITS = {
  diffRunsPerPeriod: 40,
  dynamicRunsPerPeriod: 8,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

const FREE: PlanView = {
  planKey: "free",
  kind: "free",
  name: "Free",
  description: "",
  sort: 0,
  offered: true,
  popular: false,
  contactTarget: null,
  archived: false,
  paddleProductId: null,
  versions: [
    {
      number: 1,
      role: "current",
      createdAt: "2026-10-18T10:00:00.000Z",
      keyMode: "managed",
      limits: { ...LIMITS, diffRunsPerPeriod: 10, dynamicRunsPerPeriod: 2 },
      modelAccess: { catalogEntries: [] },
      monthlyAmountMinor: null,
      yearlyAmountMinor: null,
      monthlyPrice: null,
      yearlyPrice: null,
      sellable: false,
    },
  ],
};

const TEAM: PlanView = {
  planKey: "team",
  kind: "paid",
  name: "Team",
  description: "For small teams.",
  sort: 20,
  offered: true,
  popular: false,
  contactTarget: null,
  archived: false,
  paddleProductId: null,
  versions: [
    {
      number: 1,
      role: "current",
      createdAt: "2026-10-18T10:00:00.000Z",
      keyMode: "managed",
      limits: LIMITS,
      modelAccess: { catalogEntries: ["mce_fast"] },
      monthlyAmountMinor: 1234,
      yearlyAmountMinor: 12_340,
      monthlyPrice: null,
      yearlyPrice: null,
      sellable: false,
    },
  ],
};

const PRO: PlanView = {
  ...TEAM,
  planKey: "pro",
  name: "Pro",
  sort: 30,
  popular: true,
  versions: [
    { ...TEAM.versions[0]!, number: 2, monthlyAmountMinor: 2500 },
    { ...TEAM.versions[0]!, number: 1, role: "legacy" },
  ],
};

const ENTERPRISE: PlanView = {
  planKey: "enterprise",
  kind: "contact",
  name: "Enterprise",
  description: "Let's talk.",
  sort: 90,
  offered: true,
  popular: false,
  contactTarget: "https://example.test/contact",
  archived: false,
  paddleProductId: null,
  versions: [],
};

const CATALOG = [
  {
    id: "mce_fast",
    name: "Fast",
    provider: "openrouter",
    modelId: "acme/quick-1",
    status: "released",
  },
  {
    id: "mce_deep",
    name: "Deep",
    provider: "openrouter",
    modelId: "acme/thorough-2",
    status: "released",
  },
];

function view(plans: PlanView[], extra: Partial<PlansView> = {}): PlansView {
  return {
    plans,
    catalog: CATALOG,
    ownKeyWorkspaces: 0,
    warnings: [],
    ...extra,
  };
}

function api(answer?: RequestResult<PlansWriteAnswer>) {
  const done: RequestResult<PlansWriteAnswer> = answer ?? {
    ok: true,
    data: {
      ok: true,
      clearedPopular: null,
      plans: view([FREE, TEAM, PRO, ENTERPRISE]),
    },
  };
  const create = vi.fn<(body: NewPlanBody) => Promise<typeof done>>(() =>
    Promise.resolve(done),
  );
  const change = vi.fn<
    (key: string, change: PlanChange) => Promise<typeof done>
  >(() => Promise.resolve(done));
  const remove = vi.fn<(key: string) => Promise<typeof done>>(() =>
    Promise.resolve(done),
  );
  return {
    api: { create, change, remove } satisfies PlansApi,
    create,
    change,
    remove,
  };
}

function region(name: string) {
  return within(screen.getByRole("region", { name }));
}

const ALL = view([FREE, TEAM, PRO, ENTERPRISE]);

describe("the plans page", () => {
  // #438-T10
  it("says billing is off and shows no plan", () => {
    render(<PlansForm billingOn={false} initial={null} api={api().api} />);

    expect(screen.getByText(/Billing is off/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /billing settings/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Free" })).toBeNull();
  });

  // #438-T26
  it("lists the plans in the order the server gave", () => {
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    const names = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(["Free", "Team", "Pro", "Enterprise"]);
  });

  // #438-T21
  it("shows the current version with its prices, limits and model names", () => {
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    const team = region("Team");
    expect(team.getByText(/Version 1/)).toBeTruthy();
    expect(team.getByText(/\$12\.34/)).toBeTruthy();
    expect(team.getByText(/\$123\.40/)).toBeTruthy();
    expect(team.getByText(/Fast/)).toBeTruthy();
    expect(region("Free").getByText(/10/)).toBeTruthy();
  });

  // #438-T27
  it("marks the Popular plan and shows an Enterprise plan with its contact target", () => {
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    expect(region("Pro").getByText("Popular")).toBeTruthy();
    expect(region("Team").queryByText("Popular")).toBeNull();
    expect(
      region("Enterprise").getByText("https://example.test/contact"),
    ).toBeTruthy();
    expect(region("Enterprise").queryByText(/Version/)).toBeNull();
  });

  // #438-T20
  it("warns when workspaces hold their own key and no own plan is offered", () => {
    render(
      <PlansForm
        billingOn
        initial={view([FREE], {
          ownKeyWorkspaces: 3,
          warnings: ["own_key_workspaces_without_own_plan"],
        })}
        api={api().api}
      />,
    );

    expect(screen.getByText(/3 workspaces hold their own/)).toBeTruthy();
    expect(
      screen.getByText(/no plan that uses the workspace.s own key/),
    ).toBeTruthy();
  });

  // #438-T20
  it("shows no warning without one from the server", () => {
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    expect(screen.queryByText(/hold their own/)).toBeNull();
  });
});

describe("saving the terms of a plan", () => {
  // #438-T23
  it("asks for a confirmation that names the version and says subscribers keep theirs, then sends the new price", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    const monthly = screen.getByLabelText("Monthly price (USD, tax included)");
    await user.clear(monthly);
    await user.type(monthly, "15.50");
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );

    expect(change).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /This creates version 2 of Team\. Existing subscribers keep version 1\./,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith("team", {
      terms: {
        basedOnVersion: 1,
        terms: {
          keyMode: "managed",
          limits: LIMITS,
          modelAccess: { catalogEntries: ["mce_fast"] },
          monthlyAmountMinor: 1550,
          yearlyAmountMinor: 12_340,
        },
      },
    });
  });

  // #438-T22
  it("sends no yearly price when the field is empty", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.clear(screen.getByLabelText(/Yearly price/));
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    const sent = change.mock.calls[0]?.[1] as {
      terms: { terms: { yearlyAmountMinor: number | null } };
    };
    expect(sent.terms.terms.yearlyAmountMinor).toBeNull();
  });

  it("does not send anything when the confirmation is cancelled", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(change).not.toHaveBeenCalled();
    expect(screen.queryByText(/This creates version/)).toBeNull();
  });

  // #438-T24
  it("keeps a price with three decimals from becoming a request", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    const monthly = screen.getByLabelText("Monthly price (USD, tax included)");
    await user.clear(monthly);
    await user.type(monthly, "9.999");
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );

    expect(change).not.toHaveBeenCalled();
    expect(await screen.findByText(/dollars and cents/)).toBeTruthy();
  });

  // #438-T18
  it("names the change of key mode in the confirmation, hides the model list and the operator cost limit and starts unlimited", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    expect(screen.getByLabelText(/Operator cost limit/)).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Every released entry" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("radio", { name: "The workspace's own key" }),
    );

    expect(screen.queryByLabelText(/Operator cost limit/)).toBeNull();
    expect(
      screen.queryByRole("radio", { name: "Every released entry" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Diff runs per month") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByLabelText(/Own-key cost limit/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    expect(
      screen.getByText(/key mode from our models to the workspace.s own key/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith("team", {
      terms: {
        basedOnVersion: 1,
        terms: expect.objectContaining({
          keyMode: "own",
          modelAccess: null,
          limits: {
            diffRunsPerPeriod: null,
            dynamicRunsPerPeriod: null,
            managedCostLimitMicroUsd: null,
            ownKeyCostLimitMicroUsd: null,
          },
        }),
      },
    });
  });

  // #438-T15
  it("keeps the run limits and the own-key cost limit an admin types for an own plan", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(
      screen.getByRole("radio", { name: "The workspace's own key" }),
    );
    await user.type(screen.getByLabelText("Diff runs per month"), "75");
    await user.type(screen.getByLabelText(/Own-key cost limit/), "3");
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change.mock.calls[0]?.[1]).toMatchObject({
      terms: {
        terms: {
          limits: { diffRunsPerPeriod: 75, ownKeyCostLimitMicroUsd: 3_000_000 },
        },
      },
    });
  });

  // #438-T01
  it("lets the admin pick the catalog entries by name, with the provider and model next to it", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(
      screen.getByRole("radio", { name: "Only the entries I pick" }),
    );
    expect(screen.getByText(/openrouter · acme\/thorough-2/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Deep/ }));
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change.mock.calls[0]?.[1]).toMatchObject({
      terms: {
        terms: {
          modelAccess: { catalogEntries: ["mce_fast", "mce_deep"] },
        },
      },
    });
  });

  // #438-T17
  it("gives the Free plan no key mode to choose and no price", async () => {
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    await user.click(screen.getByRole("button", { name: "Edit Free" }));

    expect(
      screen.queryByRole("radio", { name: "The workspace's own key" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/Monthly price/)).toBeNull();
    expect(screen.queryByLabelText(/Yearly price/)).toBeNull();
    expect(screen.getByText(/always runs on our models/)).toBeTruthy();
    expect(screen.getByLabelText("Diff runs per month")).toBeTruthy();
  });

  // #438-T09
  it("gives an Enterprise plan no terms at all", async () => {
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));

    expect(screen.queryByLabelText("Diff runs per month")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save as a new version" }),
    ).toBeNull();
    expect(screen.getByLabelText("Contact link or email")).toBeTruthy();
  });

  // #438-T07
  it("shows the sentence of the code the server refused with", async () => {
    const { api: mock } = api({
      ok: false,
      status: 409,
      code: "plan_changed",
      issues: [],
    });
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(
      screen.getByRole("button", { name: "Save as a new version" }),
    );
    await user.click(screen.getByRole("button", { name: "Create version 2" }));

    expect(
      await screen.findByText(describePlanFailure("plan_changed")),
    ).toBeTruthy();
  });
});

describe("the fields edited in place", () => {
  // #438-T03
  it("sends only the display fields and creates no version", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    const sort = screen.getByLabelText("Display order");
    await user.clear(sort);
    await user.type(sort, "5");
    await user.click(
      screen.getByRole("button", { name: "Save display settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith("team", {
      metadata: {
        name: "Team",
        description: "For small teams.",
        sort: 5,
        offered: true,
        popular: false,
        contactTarget: null,
      },
    });
  });

  // #438-T27
  it("names the plan that loses the Popular badge before it is moved", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(screen.getByRole("switch", { name: "Popular" }));
    await user.click(
      screen.getByRole("button", { name: "Save display settings" }),
    );

    expect(change).not.toHaveBeenCalled();
    expect(screen.getByText(/Pro loses the Popular badge/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Move the badge" }));

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change.mock.calls[0]?.[1]).toMatchObject({
      metadata: { popular: true },
    });
  });

  // #438-T27
  it("tells who lost the badge after the move", async () => {
    const answer: RequestResult<PlansWriteAnswer> = {
      ok: true,
      data: { ok: true, clearedPopular: "pro", plans: ALL },
    };
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={api(answer).api} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(screen.getByRole("switch", { name: "Popular" }));
    await user.click(
      screen.getByRole("button", { name: "Save display settings" }),
    );
    await user.click(screen.getByRole("button", { name: "Move the badge" }));

    expect(
      await screen.findByText(/Pro no longer has the Popular badge/),
    ).toBeTruthy();
  });

  // #438-T29
  it("offers no Popular switch on the Free plan and on an Enterprise plan", async () => {
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={api().api} />);

    await user.click(screen.getByRole("button", { name: "Edit Free" }));
    expect(screen.queryByRole("switch", { name: "Popular" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));
    expect(screen.queryByRole("switch", { name: "Popular" })).toBeNull();
  });

  // #438-T30
  it("sends the contact target of an Enterprise plan", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));
    const target = screen.getByLabelText("Contact link or email");
    await user.clear(target);
    await user.type(target, "mailto:sales@example.test");
    await user.click(
      screen.getByRole("button", { name: "Save display settings" }),
    );

    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change.mock.calls[0]?.[1]).toMatchObject({
      metadata: { contactTarget: "mailto:sales@example.test" },
    });
  });

  // #438-T30
  it("shows the sentence for an address that is not https or mailto", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "contact_target_invalid",
      issues: [{ field: "contactTarget", code: "contact_target_invalid" }],
    });
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));
    await user.click(
      screen.getByRole("button", { name: "Save display settings" }),
    );

    expect(
      await screen.findByText(/Enter an https link, or an email address/),
    ).toBeTruthy();
  });
});

describe("a new plan", () => {
  // #438-T01
  it("creates a paid plan with its first terms and prices", async () => {
    const { api: mock, create } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={view([FREE])} api={mock} />);

    await user.click(screen.getByRole("button", { name: "New plan" }));
    const form = within(screen.getByRole("form", { name: "New plan" }));
    await user.type(form.getByLabelText("Plan key"), "starter");
    await user.type(form.getByLabelText("Name"), "Starter");
    await user.type(form.getByLabelText("Display order"), "10");
    await user.type(
      form.getByLabelText("Monthly price (USD, tax included)"),
      "9.99",
    );
    await user.type(form.getByLabelText("Diff runs per month"), "20");
    await user.click(form.getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      planKey: "starter",
      kind: "paid",
      name: "Starter",
      description: "",
      sort: 10,
      offered: true,
      popular: false,
      contactTarget: null,
      terms: {
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: 20,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        modelAccess: { catalogEntries: null },
        monthlyAmountMinor: 999,
        yearlyAmountMinor: null,
      },
    });
  });

  // #438-T14
  it("creates an own plan unlimited, with no model access", async () => {
    const { api: mock, create } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={view([FREE])} api={mock} />);

    await user.click(screen.getByRole("button", { name: "New plan" }));
    const form = within(screen.getByRole("form", { name: "New plan" }));
    await user.type(form.getByLabelText("Plan key"), "own-key");
    await user.type(form.getByLabelText("Name"), "Own key");
    await user.type(form.getByLabelText("Display order"), "15");
    await user.click(
      form.getByRole("radio", { name: "The workspace's own key" }),
    );
    await user.type(
      form.getByLabelText("Monthly price (USD, tax included)"),
      "10",
    );
    await user.click(form.getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      kind: "paid",
      terms: {
        keyMode: "own",
        modelAccess: null,
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
        },
        monthlyAmountMinor: 1000,
      },
    });
  });

  // #438-T30
  it("creates an Enterprise plan with a contact target and no terms", async () => {
    const { api: mock, create } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={view([FREE])} api={mock} />);

    await user.click(screen.getByRole("button", { name: "New plan" }));
    const form = within(screen.getByRole("form", { name: "New plan" }));
    await user.click(form.getByRole("radio", { name: "Enterprise" }));
    await user.type(form.getByLabelText("Plan key"), "enterprise");
    await user.type(form.getByLabelText("Name"), "Enterprise");
    await user.type(form.getByLabelText("Display order"), "90");
    await user.type(
      form.getByLabelText("Contact link or email"),
      "https://example.test/talk",
    );
    expect(form.queryByLabelText("Diff runs per month")).toBeNull();
    await user.click(form.getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "contact",
      contactTarget: "https://example.test/talk",
    });
    expect(body).not.toHaveProperty("terms");
  });
});

describe("archiving and deleting", () => {
  it("archives a plan and restores it", async () => {
    const { api: mock, change } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    await user.click(screen.getByRole("button", { name: "Archive Team" }));

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith("team", { archived: true }),
    );
  });

  // #438-T08
  it("offers no archive and no delete for the Free plan, and delete only for an Enterprise plan", async () => {
    const { api: mock, remove } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Free" }));
    expect(screen.queryByRole("button", { name: /^Archive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Team" }));
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));
    await user.click(screen.getByRole("button", { name: "Delete Enterprise" }));
    await user.click(screen.getByRole("button", { name: "Delete the plan" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("enterprise"));
  });
});

// The Paddle prices of a version (#439): the cached price next to the entered amount, a field for a Paddle price id and for
// nothing else, the drift that blocks offering, and the copy for every refusal.
const MONTHLY_PRICE: PriceLinkView = {
  paddlePriceId: "pri_01fake0000000000000000001",
  interval: "month",
  frequency: 1,
  currency: "USD",
  taxMode: "internal",
  amount: "1234",
  status: "active",
  trialDays: null,
  snapshotAt: "2026-10-18T10:05:00.000Z",
  drift: null,
};

const YEARLY_PRICE: PriceLinkView = {
  ...MONTHLY_PRICE,
  paddlePriceId: "pri_01fake0000000000000000002",
  interval: "year",
  amount: "12340",
};

function teamWith(
  prices: Partial<
    Pick<PlanVersionView, "monthlyPrice" | "yearlyPrice" | "sellable">
  >,
  version: Partial<PlanVersionView> = {},
): PlansView {
  return view([
    FREE,
    {
      ...TEAM,
      paddleProductId: "pro_01fake0000000000000000001",
      versions: [{ ...TEAM.versions[0]!, ...prices, ...version }],
    },
  ]);
}

async function openPrices(initial: PlansView, mock: PlansApi) {
  const user = userEvent.setup();
  render(<PlansForm billingOn initial={initial} api={mock} />);
  await user.click(screen.getByRole("button", { name: "Edit Team" }));
  return {
    user,
    prices: within(screen.getByRole("form", { name: "Paddle prices of Team" })),
  };
}

describe("the Paddle prices of a plan version", () => {
  // #439-T07
  it("has a field for a Paddle price id per slot and no field for an amount, a currency or a tax mode", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(teamWith({}), mock);

    const fields = prices.getAllByRole("textbox");

    expect(
      fields.map((field) => field.getAttribute("aria-label") ?? ""),
    ).toEqual(["Monthly Paddle price ID", "Yearly Paddle price ID"]);
    expect(prices.queryByRole("spinbutton")).toBeNull();
    expect(prices.queryByLabelText(/amount|currency|tax mode/i)).toBeNull();
    // The entered amounts are shown, as text, next to their slot.
    expect(prices.getByText(/Entered for this version: \$12\.34/)).toBeTruthy();
    expect(
      prices.getByText(/Entered for this version: \$123\.40/),
    ).toBeTruthy();
  });

  // #439-T01
  it("sends the price id for the slot of the current version, trimmed, and says it was linked", async () => {
    const { api: mock, change } = api();
    const { user, prices } = await openPrices(teamWith({}), mock);

    await user.type(
      prices.getByLabelText("Monthly Paddle price ID"),
      "  pri_01fake0000000000000000001 ",
    );
    await user.click(
      prices.getByRole("button", { name: "Link monthly price" }),
    );

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith("team", {
        priceLink: {
          versionNumber: 1,
          interval: "month",
          paddlePriceId: "pri_01fake0000000000000000001",
        },
      }),
    );
    expect(
      await screen.findByText(/Monthly price of Team linked\./),
    ).toBeTruthy();
  });

  // #439-T01
  it("shows the cached price read-only next to the entered amount, and that the version is ready to sell", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(
      teamWith({
        monthlyPrice: MONTHLY_PRICE,
        yearlyPrice: YEARLY_PRICE,
        sellable: true,
      }),
      mock,
    );

    expect(prices.getByText("pri_01fake0000000000000000001")).toBeTruthy();
    expect(
      prices.getByText(/Paddle: \$12\.34 USD every month, tax included/),
    ).toBeTruthy();
    expect(
      prices.getByText(/Paddle: \$123\.40 USD every year, tax included/),
    ).toBeTruthy();
    expect(prices.getByText(/Ready to sell/)).toBeTruthy();
    expect(prices.queryByText(/Differs/)).toBeNull();
  });

  // #439-T04
  it("shows a price that differs from the entered amount as a drift and says the version is not for sale", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(
      teamWith({
        monthlyPrice: {
          ...MONTHLY_PRICE,
          amount: "1500",
          drift: "price_amount_mismatch",
          driftEntered: "1234",
          driftPaddle: "1500",
        },
        yearlyPrice: YEARLY_PRICE,
        sellable: false,
      }),
      mock,
    );

    expect(
      prices.getByText(
        /Differs from this version: Paddle has \$15\.00, but \$12\.34 is entered for this version\./,
      ),
    ).toBeTruthy();
    expect(prices.getByText(/Not for sale yet/)).toBeTruthy();
    expect(prices.queryByText(/Ready to sell/)).toBeNull();
  });

  // #439-T04
  it("says that an archived price is a drift too, and that the app never changes Paddle", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(
      teamWith({
        monthlyPrice: {
          ...MONTHLY_PRICE,
          status: "archived",
          drift: "price_not_active",
        },
        sellable: false,
      }),
      mock,
    );

    expect(
      prices.getByText(
        /Differs from this version: the price is archived at Paddle/,
      ),
    ).toBeTruthy();
    expect(prices.getByText(/never changes a price at Paddle/)).toBeTruthy();
  });

  // #439-T03
  it("offers no yearly slot for a version without a yearly price", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(
      teamWith({}, { yearlyAmountMinor: null }),
      mock,
    );

    expect(prices.queryByLabelText("Yearly Paddle price ID")).toBeNull();
    expect(
      prices.getByText(/No yearly price is entered for this version/),
    ).toBeTruthy();
  });

  // #439-T04
  it("refreshes the linked prices from Paddle on request", async () => {
    const { api: mock, change } = api();
    const { user, prices } = await openPrices(
      teamWith({ monthlyPrice: MONTHLY_PRICE }),
      mock,
    );

    await user.click(
      prices.getByRole("button", { name: "Refresh from Paddle" }),
    );

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith("team", { refreshPrices: true }),
    );
  });

  // #439-T04 (review of #468, N7)
  it("names the prices a refresh could not read, with the reason of each", async () => {
    const { api: mock } = api({
      ok: false,
      status: 502,
      code: "paddle_unavailable",
      issues: [
        { field: "pri_01fakeaaaa", code: "paddle_unavailable" },
        { field: "pri_01fakebbbb", code: "price_not_found" },
      ],
    });
    const { user, prices } = await openPrices(
      teamWith({ monthlyPrice: MONTHLY_PRICE }),
      mock,
    );

    await user.click(
      prices.getByRole("button", { name: "Refresh from Paddle" }),
    );

    expect(
      await prices.findByText(
        /pri_01fakeaaaa: Paddle failed to answer.*pri_01fakebbbb: Paddle does not know this price/,
      ),
    ).toBeTruthy();
    expect(prices.getByText(/Reload the page to see them/)).toBeTruthy();
  });

  it("offers no refresh while no price is linked", async () => {
    const { api: mock } = api();
    const { prices } = await openPrices(teamWith({}), mock);

    expect(
      prices.queryByRole("button", { name: "Refresh from Paddle" }),
    ).toBeNull();
  });

  // #439-T11
  it("says what was entered and what Paddle has when a price is refused for its amount", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "price_amount_mismatch",
      issues: [{ field: "paddlePriceId", code: "price_amount_mismatch" }],
      details: { entered: "1234", paddle: "1235" },
    });
    const { user, prices } = await openPrices(teamWith({}), mock);

    await user.type(
      prices.getByLabelText("Monthly Paddle price ID"),
      "pri_01fakeaaaa",
    );
    await user.click(
      prices.getByRole("button", { name: "Link monthly price" }),
    );

    expect(
      await prices.findByText(
        /Paddle has \$12\.35, but \$12\.34 is entered for this version\./,
      ),
    ).toBeTruthy();
  });

  // #439-T11
  it("reads nothing but text from the two values of a refusal", async () => {
    const { api: mock } = api({
      ok: false,
      status: 422,
      code: "price_amount_mismatch",
      issues: [{ field: "paddlePriceId", code: "price_amount_mismatch" }],
      details: { entered: 5, paddle: { a: 1 }, secret: "never-shown" },
    });
    const { user, prices } = await openPrices(teamWith({}), mock);

    await user.type(
      prices.getByLabelText("Monthly Paddle price ID"),
      "pri_01fakeaaaa",
    );
    await user.click(
      prices.getByRole("button", { name: "Link monthly price" }),
    );

    expect(
      await prices.findByText(
        /The price at Paddle does not carry the amount entered/,
      ),
    ).toBeTruthy();
    expect(prices.queryByText(/never-shown/)).toBeNull();
  });

  // #439-T02
  it("has its own sentence for every refusal of a link", () => {
    const sentences = new Map<string, string>();
    for (const code of PRICE_CODES) {
      const sentence = describePlanFailure(code);
      expect(sentence, code).not.toBe(GENERIC_FAILURE);
      sentences.set(code, sentence);
    }
    expect(new Set(sentences.values()).size).toBe(sentences.size);
  });

  it("gives the Free plan and an Enterprise plan no Paddle prices", async () => {
    const { api: mock } = api();
    const user = userEvent.setup();
    render(<PlansForm billingOn initial={ALL} api={mock} />);

    await user.click(screen.getByRole("button", { name: "Edit Free" }));
    expect(screen.queryByRole("form", { name: /Paddle prices/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Enterprise" }));
    expect(screen.queryByRole("form", { name: /Paddle prices/ })).toBeNull();
  });
});
