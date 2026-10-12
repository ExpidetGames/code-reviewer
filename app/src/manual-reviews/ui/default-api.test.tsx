// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down that the panel and the runs list, when nobody hands them a client for the app's routes (the
// running app), make one client for the workspace of the page and keep it: a client made again on every
// render would restart the request that depends on it, over and over. They call the routes of the
// workspace in the address.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { StartReviewPanel } from "./start-review-panel.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the panel without a client handed in", () => {
  // #101-WM-03
  it("asks the workspace in the address for the pull requests once, however often it renders", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        repositoryId: "repo-1",
        pullRequests: [
          { number: 7, title: "Add caching", author: "alice", draft: false },
        ],
        allowedCommands: ["review", "describe"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<StartReviewPanel workspaceSlug="team-a" repositoryId="repo-1" />);

    await user.click(await screen.findByRole("radio", { name: /#7/ }));
    await user.selectOptions(
      screen.getByLabelText("Command to run"),
      "describe",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/w/team-a/repositories/repo-1/pull-requests",
      expect.objectContaining({ method: "GET" }),
    );
    // What was picked is still picked: nothing reloaded the list under the person's hands.
    expect(
      (screen.getByRole("radio", { name: /#7/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});
