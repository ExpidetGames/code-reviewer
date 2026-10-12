// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the Connections page: what a flow just ended with, the connections with their state, the buttons an
// Owner or Admin gets (and a Member does not), what is said while Connect GitHub cannot be offered, the list of
// installations to choose from, the two-step end of a connection, and that names from GitHub are text.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { BindingApi } from "./api.ts";
import { ConnectionsPanel } from "./connections-panel.tsx";
import type { ConnectionsPageData } from "./connections-page.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const URL_ON_GITHUB = "https://github.test/apps/x/installations/new?state=abc";

function data(
  overrides: Partial<ConnectionsPageData> = {},
): ConnectionsPageData {
  return {
    connect: "available",
    picker: true,
    connections: [],
    requests: [],
    notice: null,
    choices: null,
    ...overrides,
  };
}

function api(overrides: Partial<BindingApi> = {}): BindingApi {
  return {
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    startPicker: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    choose: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    disconnect: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const },
    })),
    sync: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  pageData: ConnectionsPageData,
  options: {
    canManage?: boolean;
    api?: BindingApi;
    go?: (url: string) => void;
  } = {},
) {
  const calls = options.api ?? api();
  const go = options.go ?? vi.fn();
  render(
    <ConnectionsPanel
      workspaceSlug="acme"
      canManage={options.canManage ?? true}
      data={pageData}
      api={calls}
      go={go}
    />,
  );
  return { api: calls, go };
}

describe("the buttons", () => {
  // #103-IB-02
  it("sends the browser to the address the route answered when an Owner or Admin presses Connect GitHub", async () => {
    const user = userEvent.setup();
    const { api: calls, go } = renderPanel(data());

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(calls.connect).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(URL_ON_GITHUB);
  });

  // #103-IB-15
  it("shows a Member the connections and no button", () => {
    renderPanel(
      data({
        connections: [
          {
            id: "i1",
            accountLogin: "acme",
            accountType: "Organization",
            status: "active",
            repositoryCount: 2,
          },
        ],
        requests: null,
      }),
      { canManage: false },
    );

    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Connect GitHub")).toBeNull();
  });

  // #103-IB-22
  it.each([
    ["app_not_configured", /not set up yet/],
    [
      "user_authorization_not_configured",
      /Connecting GitHub is not available yet/,
    ],
  ] as const)(
    "does not offer Connect GitHub while it cannot work (%s), and says why",
    (connect, reason) => {
      renderPanel(data({ connect, picker: false }));

      expect(
        (
          screen.getByRole("button", {
            name: "Connect GitHub",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(screen.getByRole("note").textContent).toMatch(reason);
      expect(
        screen.queryByRole("button", { name: "Link an existing installation" }),
      ).toBeNull();
    },
  );

  // #103-IB-22
  it("offers Connect GitHub but says that the admin of the instance decides, while nobody's rights can be checked", () => {
    renderPanel(data({ connect: "needs_approval", picker: false }));

    expect(
      (
        screen.getByRole("button", {
          name: "Connect GitHub",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByRole("note").textContent).toMatch(
      /admin of the instance approves/,
    );
  });

  // #103-IB-10
  it("shows the list of installations to choose from and starts the link of the one chosen", async () => {
    const user = userEvent.setup();
    const { api: calls, go } = renderPanel(
      data({
        choices: {
          picker: "signed-list",
          entries: [
            {
              installationId: "4242",
              accountLogin: "acme",
              accountType: "Organization",
            },
            {
              installationId: "4300",
              accountLogin: "octo",
              accountType: "User",
            },
          ],
        },
      }),
    );

    const list = screen.getByRole("list", {
      name: "Installations you can link",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Link octo" }));

    expect(calls.choose).toHaveBeenCalledWith("signed-list", "4300");
    expect(go).toHaveBeenCalledWith(URL_ON_GITHUB);
  });

  // #103-IB-10
  it("says so when no installation is left to choose from", () => {
    renderPanel(data({ choices: { picker: "p", entries: [] } }));

    expect(
      screen.getByText(/shows no installation that you can use/),
    ).toBeTruthy();
  });

  // #103-IB-02
  it("says in words why a start failed and stays on the page", async () => {
    const user = userEvent.setup();
    const { go } = renderPanel(data(), {
      api: api({
        connect: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          code: "rate_limited",
          issues: [],
        })),
      }),
    });

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Too many attempts/,
    );
    expect(go).not.toHaveBeenCalled();
  });
});

describe("what a flow ended with", () => {
  // #103-IB-10
  it("shows the notice of a flow that ended well as a status", () => {
    renderPanel(
      data({ notice: { tone: "info", text: "Nothing is connected yet." } }),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Nothing is connected yet.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #103-IB-04
  it("shows the notice of a refusal as an alert", () => {
    renderPanel(
      data({
        notice: {
          tone: "error",
          text: "That installation cannot be connected.",
        },
      }),
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "That installation cannot be connected.",
    );
  });
});

describe("a connection", () => {
  const connection = {
    id: "i1",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active" as const,
    repositoryCount: 1,
  };

  // #103-IB-14
  it("is ended in two steps: the first press asks, the second ends it and the page reloads", async () => {
    const user = userEvent.setup();
    const { api: calls } = renderPanel(data({ connections: [connection] }));

    await user.click(screen.getByRole("button", { name: "Disconnect acme" }));
    expect(calls.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/Projects and runs stay/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Confirm disconnecting acme" }),
    );

    expect(calls.disconnect).toHaveBeenCalledWith("i1");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #103-IB-14
  it("is not ended when the person cancels", async () => {
    const user = userEvent.setup();
    const { api: calls } = renderPanel(data({ connections: [connection] }));

    await user.click(screen.getByRole("button", { name: "Disconnect acme" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(calls.disconnect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Disconnect acme" }),
    ).toBeTruthy();
  });

  // #103-IB-14
  it("shows an ended connection as disconnected, without a button", () => {
    renderPanel(
      data({
        connections: [{ ...connection, status: "disconnected" as const }],
      }),
    );

    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Disconnect acme/ }),
    ).toBeNull();
  });

  // #103-IB-10
  it("renders a name from GitHub as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    renderPanel(
      data({ connections: [{ ...connection, accountLogin: hostile }] }),
    );

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("the requests", () => {
  // #103-IB-19
  it("lists the requests of the workspace with their state for an Owner or Admin", () => {
    renderPanel(
      data({
        requests: [
          {
            id: "r1",
            accountLogin: "acme",
            status: "pending",
            createdAt: "2026-10-12T10:00:00.000Z",
            decidedAt: null,
          },
          {
            id: "r2",
            accountLogin: "beta",
            status: "denied",
            createdAt: "2026-10-11T10:00:00.000Z",
            decidedAt: "2026-10-11T12:00:00.000Z",
          },
        ],
      }),
    );

    const list = screen.getByRole("list", {
      name: "Requests for the instance admin",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(
      /Waiting for the admin of the instance/,
    );
    expect(items[1]?.textContent).toMatch(
      /Denied by the admin of the instance/,
    );
  });

  // #103-IB-15
  it("does not show them to a Member", () => {
    renderPanel(data({ requests: null }), { canManage: false });

    expect(
      screen.queryByRole("list", { name: "Requests for the instance admin" }),
    ).toBeNull();
  });
});
