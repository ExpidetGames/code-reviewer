// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The fetch of the catalog on the admin page (#554): when it last worked and how the last attempt ended (the stable code as
// a sentence), "Fetch now", and the guard: a fetch the guard stopped is applied only after the admin has read why and
// accepted it, and the acceptance is a second, explicit request.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchState } from "../../models-dev/catalog.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { FETCH_OK } from "../../test-support/catalog-models-fixtures.ts";
import type { CatalogModelsApi, FetchApplied } from "./api.ts";
import { FetchPanel } from "./fetch-panel.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const APPLIED: RequestResult<FetchApplied> = {
  ok: true,
  data: { ok: true, outcome: "applied", summary: {} },
};
const refused = (
  code: string,
  status = 409,
  details?: Record<string, unknown>,
): RequestResult<FetchApplied> => ({
  ok: false,
  status,
  code,
  issues: [],
  ...(details === undefined ? {} : { details }),
});

/** What the route answers a guard stop with (`details`): the figures the guard measured. */
const FIGURES = {
  unlisted: 3,
  listed: 13,
  listedAfter: 20,
  providersUnlisted: 0,
  providersListed: 6,
  enabledUnlisted: 0,
  enabledListed: 0,
  newlyBlocked: 0,
  providers: 6,
  oversizedProviders: 0,
};

function fakeApi(...answers: Array<RequestResult<FetchApplied>>) {
  const fetchNow = vi.fn();
  for (const answer of answers) fetchNow.mockResolvedValueOnce(answer);
  return { fetchNow } as unknown as CatalogModelsApi & {
    fetchNow: typeof fetchNow;
  };
}

describe("the state of the fetch", () => {
  // #554-T08
  it("shows the last success and the last attempt, and what the last fetch changed", () => {
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={fakeApi()} />);

    const panel = within(screen.getByRole("region", { name: "Catalog fetch" }));
    expect(panel.getAllByText("2026-10-20 03:00 UTC")).toHaveLength(2);
    expect(panel.getByText("Worked")).toBeTruthy();
    expect(
      panel.getByText(/2 new, 1 changed, 0 unlisted of 13 models/),
    ).toBeTruthy();
  });

  // #554-T08
  it("shows the last failure as a sentence and keeps the stable code next to it", () => {
    const failed: FetchState = {
      ...FETCH_OK,
      lastAttemptAt: "2026-10-20T05:00:00.000Z",
      lastStatus: "failed",
      lastError: "models_dev_http_status",
    };
    render(<FetchPanel fetch={failed} fetchEnabled api={fakeApi()} />);

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(
      screen.getByText(/models.dev answered with an error status/),
    ).toBeTruthy();
    expect(screen.getByText("models_dev_http_status").tagName).toBe("CODE");
    expect(screen.getByText("2026-10-20 05:00 UTC")).toBeTruthy();
  });

  // #554-T08
  it("says that no fetch has run, and notes the providers still to look up", () => {
    const { unmount } = render(
      <FetchPanel fetch={null} fetchEnabled api={fakeApi()} />,
    );
    expect(screen.getByText("No fetch has run yet.")).toBeTruthy();
    expect(screen.getAllByText("never")).toHaveLength(2);
    unmount();

    render(
      <FetchPanel
        fetch={{
          ...FETCH_OK,
          lastSummary: { models: 5, retryProviders: 2, lookupsSkipped: 3 },
        }}
        fetchEnabled
        api={fakeApi()}
      />,
    );
    expect(
      screen.getByText(/2 new provider\(s\) did not resolve yet/),
    ).toBeTruthy();
    expect(screen.getByText(/3 address look-ups ran out of time/)).toBeTruthy();
  });

  // #554-T08
  it("cannot fetch when the instance switched the fetch off, and says so", () => {
    render(<FetchPanel fetch={null} fetchEnabled={false} api={fakeApi()} />);

    expect(
      (screen.getByRole("button", { name: "Fetch now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/The fetch is switched off/)).toBeTruthy();
  });
});

describe("fetching now", () => {
  // #554-T08
  it("fetches with no acceptance and reloads the page", async () => {
    const api = fakeApi(APPLIED);
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect(await screen.findByText("The catalog was fetched.")).toBeTruthy();
    expect(api.fetchNow).toHaveBeenCalledTimes(1);
    expect(api.fetchNow).toHaveBeenCalledWith();
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #554-T08
  it("explains a fetch that failed, and reloads the page to show how it was recorded", async () => {
    const api = fakeApi(refused("models_dev_unreachable", 503));
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /models.dev could not be reached/,
    );
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #554-T08
  it("says how long to wait when the route is rate limited", async () => {
    const api = fakeApi(
      refused("fetch_rate_limited", 429, { retryAfterSeconds: 250 }),
    );
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /fetched too often.*Try again in 5 minute\(s\)/,
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #554-T08
  it("offers another try while a fetch is running, and the try is the same request", async () => {
    const api = fakeApi(refused("fetch_in_progress"), APPLIED);
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );

    expect(await screen.findByText("The catalog was fetched.")).toBeTruthy();
    expect(api.fetchNow).toHaveBeenCalledTimes(2);
    expect(api.fetchNow).toHaveBeenNthCalledWith(2);
  });
});

describe("a fetch the guard stopped", () => {
  // #548 review round: the guard code is translated, and the override asks first
  it("asks before it overrides the guard, says why it stopped, and applies nothing on cancel", async () => {
    const api = fakeApi(refused("models_dev_guard_growth"));
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText("Apply this fetch anyway?")).toBeTruthy();
    expect(
      dialog.getByText(/grow the listed models by more than half/),
    ).toBeTruthy();
    expect(dialog.getByText(/overrides the guard/)).toBeTruthy();
    await userEvent.click(
      dialog.getByRole("button", { name: "Keep the catalog as it is" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.fetchNow).toHaveBeenCalledTimes(1);
  });

  // #548 review round: the acceptance is explicit
  it("sends the acceptance only after the admin chose to apply the fetch anyway", async () => {
    const api = fakeApi(refused("models_dev_guard_unlisted_share"), APPLIED);
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(
      dialog.getByText(/unlist an unusually large share of the catalog/),
    ).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "Apply anyway" }));

    expect(await screen.findByText("The catalog was fetched.")).toBeTruthy();
    expect(api.fetchNow).toHaveBeenNthCalledWith(1);
    expect(api.fetchNow).toHaveBeenNthCalledWith(2, {
      acceptReasons: ["models_dev_guard_unlisted_share"],
    });
  });

  // #554-T08
  it("lists every reason that tripped with its figures, and the second request names exactly those reasons", async () => {
    const api = fakeApi(
      refused("models_dev_guard_unlisted_share", 409, {
        reasons: ["models_dev_guard_unlisted_share", "models_dev_guard_growth"],
        details: FIGURES,
      }),
      APPLIED,
    );
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    const dialog = within(await screen.findByRole("alertdialog"));

    const items = dialog
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      expect.stringContaining("unlist an unusually large share of the catalog"),
      expect.stringContaining("grow the listed models by more than half"),
    ]);
    expect(items[0]).toContain("It would unlist 3 of 13 listed models.");
    expect(items[1]).toContain(
      "The listed models would grow from 13 to 20 (+54%).",
    );
    await userEvent.click(dialog.getByRole("button", { name: "Apply anyway" }));

    expect(await screen.findByText("The catalog was fetched.")).toBeTruthy();
    expect(api.fetchNow).toHaveBeenNthCalledWith(2, {
      acceptReasons: [
        "models_dev_guard_unlisted_share",
        "models_dev_guard_growth",
      ],
    });
  });

  // #554-T08
  it.each([
    [
      "models_dev_guard_enabled_unlisted",
      "It would unlist 4 of the 5 models you enabled.",
    ],
    [
      "models_dev_guard_url_changed_share",
      "It would block the address of 3 of 6 providers.",
    ],
    [
      "models_dev_guard_provider_size",
      "2 provider(s) hold more models than any provider has and would be left out.",
    ],
  ])("shows the figures of %s", async (code, sentence) => {
    const api = fakeApi(
      refused(code, 409, {
        reasons: [code],
        details: {
          ...FIGURES,
          enabledUnlisted: 4,
          enabledListed: 5,
          newlyBlocked: 3,
          providers: 6,
          oversizedProviders: 2,
        },
      }),
    );
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect(
      within(await screen.findByRole("alertdialog")).getByText(
        new RegExp(sentence.replaceAll("(", "\\(").replaceAll(")", "\\)")),
      ),
    ).toBeTruthy();
  });

  // #554-T08
  it("asks again, and marks what is new, when the second fetch trips a reason the admin did not accept", async () => {
    const api = fakeApi(
      refused("models_dev_guard_unlisted_share", 409, {
        reasons: ["models_dev_guard_unlisted_share"],
        details: FIGURES,
      }),
      refused("models_dev_guard_unlisted_share", 409, {
        reasons: ["models_dev_guard_unlisted_share", "models_dev_guard_growth"],
        details: FIGURES,
      }),
      APPLIED,
    );
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Apply anyway",
      }),
    );

    await waitFor(() => expect(api.fetchNow).toHaveBeenCalledTimes(2));
    expect(api.fetchNow).toHaveBeenNthCalledWith(2, {
      acceptReasons: ["models_dev_guard_unlisted_share"],
    });
    const dialog = within(await screen.findByRole("alertdialog"));
    const items = dialog.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).not.toContain("New since you looked");
    expect(items[1]?.textContent).toContain("New since you looked");
    await userEvent.click(dialog.getByRole("button", { name: "Apply anyway" }));

    await waitFor(() => expect(api.fetchNow).toHaveBeenCalledTimes(3));
    expect(api.fetchNow).toHaveBeenNthCalledWith(3, {
      acceptReasons: [
        "models_dev_guard_unlisted_share",
        "models_dev_guard_growth",
      ],
    });
  });

  // #554-T08
  it("falls back to the code alone when the answer carries no list of reasons", async () => {
    const api = fakeApi(refused("models_dev_guard_growth"), APPLIED);
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Apply anyway",
      }),
    );

    await waitFor(() => expect(api.fetchNow).toHaveBeenCalledTimes(2));
    expect(api.fetchNow).toHaveBeenNthCalledWith(2, {
      acceptReasons: ["models_dev_guard_growth"],
    });
  });

  // #554-T08
  it("ignores a list of reasons that holds anything but the guard's codes", async () => {
    const api = fakeApi(
      refused("models_dev_guard_growth", 409, {
        reasons: ["models_dev_guard_growth", "<img src=x>", 7],
        details: { listed: "many" },
      }),
      APPLIED,
    );
    render(<FetchPanel fetch={FETCH_OK} fetchEnabled api={api} />);

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(dialog.getByRole("button", { name: "Apply anyway" }));

    await waitFor(() => expect(api.fetchNow).toHaveBeenCalledTimes(2));
    expect(api.fetchNow).toHaveBeenNthCalledWith(2, {
      acceptReasons: ["models_dev_guard_growth"],
    });
  });

  // #548 review round: the guard code is translated
  it.each([
    "models_dev_guard_unlisted_share",
    "models_dev_guard_growth",
    "models_dev_guard_url_changed_share",
    "models_dev_guard_provider_size",
  ])("treats %s as a guard stop, not as a failure", async (code) => {
    render(
      <FetchPanel fetch={FETCH_OK} fetchEnabled api={fakeApi(refused(code))} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #548 review round: not a guard
  it("does not offer to override a fetch that ran out of time", async () => {
    render(
      <FetchPanel
        fetch={FETCH_OK}
        fetchEnabled
        api={fakeApi(refused("models_dev_timeout", 503))}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Fetch now" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /ran out of time before it wrote anything/,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
