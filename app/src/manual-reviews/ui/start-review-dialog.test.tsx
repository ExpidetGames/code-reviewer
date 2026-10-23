// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the play button of a project row and its dialog (#655): the button has a name that
// carries the repository, the dialog lists the open pull requests of the repository and starts the
// picked one, and its empty and error states speak in plain words. A project that is not active has
// the button disabled with the reason.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { OpenPullRequests, StartedReview } from "../service.ts";
import type { ManualReviewApi } from "./api.ts";
import { StartReviewDialog } from "./start-review-dialog.tsx";

afterEach(cleanup);

function pullRequests(numbers: number[]): RequestResult<OpenPullRequests> {
  return {
    ok: true,
    data: {
      repositoryId: "repo-1",
      fullName: "acme/widgets",
      allowedCommands: ["review"],
      pullRequests: numbers.map((number) => ({
        number,
        title: `Change ${number}`,
        url: `https://github.com/acme/widgets/pull/${number}`,
        author: "alice",
        draft: false,
        headRef: "feature",
        baseRef: "main",
      })),
    },
  };
}

function fakeApi(list: RequestResult<OpenPullRequests>) {
  const listPullRequests = vi.fn<ManualReviewApi["listPullRequests"]>(
    async () => list,
  );
  const startReview = vi.fn<ManualReviewApi["startReview"]>(
    async (): Promise<RequestResult<StartedReview>> => ({
      ok: true,
      data: { runId: "run-9", created: true, prNumber: 7, command: "review" },
    }),
  );
  return {
    api: { listPullRequests, startReview },
    listPullRequests,
    startReview,
  };
}

function renderDialog(api: ManualReviewApi, startable = true) {
  render(
    <StartReviewDialog
      workspaceSlug="acme"
      repositoryId="repo-1"
      fullName="acme/widgets"
      startable={startable}
      api={api}
    />,
  );
  return userEvent.setup();
}

const play = () =>
  screen.getByRole("button", { name: "Start a review of acme/widgets" });

describe("the play button and its dialog", () => {
  // #655-T03
  it("lists the open pull requests only once it is opened and queues the picked one", async () => {
    const { api, listPullRequests, startReview } = fakeApi(
      pullRequests([7, 3]),
    );
    const user = renderDialog(api);
    expect(listPullRequests).not.toHaveBeenCalled();

    await user.click(play());
    const dialog = await screen.findByRole("dialog", {
      name: "Start a review",
    });
    await user.click(await within(dialog).findByRole("radio", { name: /#7/ }));
    expect(within(dialog).getByRole("radio", { name: /#3/ })).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Start review" }),
    );

    expect(listPullRequests).toHaveBeenCalledWith("repo-1");
    expect(startReview).toHaveBeenCalledWith("repo-1", {
      prNumber: 7,
      command: "review",
    });
    expect((await within(dialog).findByRole("status")).textContent).toContain(
      "Started: review for pull request #7",
    );
  });

  // #655-T04
  it("says that there is no open pull request", async () => {
    const user = renderDialog(fakeApi(pullRequests([])).api);

    await user.click(play());

    expect(
      await screen.findByText(/There are no open pull requests/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Start review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #655-T04
  it("says that GitHub could not be read and offers to try again", async () => {
    const user = renderDialog(
      fakeApi({
        ok: false,
        status: 502,
        code: "MANUAL_REVIEW_GITHUB_UNAVAILABLE",
        issues: [],
      }).api,
    );

    await user.click(play());

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub could not be reached",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  // #655-T02
  it("shows the button disabled, with the reason, while the project is not active", () => {
    const { api, listPullRequests } = fakeApi(pullRequests([7]));
    renderDialog(api, false);

    const button = play() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Switch the project on to start a review.");
    expect(listPullRequests).not.toHaveBeenCalled();
  });
});
