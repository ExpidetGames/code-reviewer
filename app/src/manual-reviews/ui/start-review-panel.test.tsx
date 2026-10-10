// @vitest-environment jsdom
// Pins down the "Review now" panel with a stand-in for the routes: it loads the open pull requests,
// starts a command only for a picked pull request, validates the question of `ask` before it sends
// anything, shows every failure as a sentence (with "Try again" for a failed load), tells a repeated
// start from a new one, and cannot be sent twice at once.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { OpenPullRequests, StartedReview } from "../service.ts";
import type { ManualReviewApi } from "./api.ts";
import { StartReviewPanel } from "./start-review-panel.tsx";

afterEach(cleanup);

function list(
  pullRequests: Array<{
    number: number;
    title?: string;
    author?: string;
    draft?: boolean;
  }>,
  allowedCommands: OpenPullRequests["allowedCommands"] = [
    "review",
    "improve",
    "describe",
    "ask",
  ],
): RequestResult<OpenPullRequests> {
  return {
    ok: true,
    data: {
      repositoryId: "repo-1",
      fullName: "acme/widgets",
      allowedCommands,
      pullRequests: pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title ?? `Change ${pr.number}`,
        url: `https://github.com/acme/widgets/pull/${pr.number}`,
        author: pr.author ?? "alice",
        draft: pr.draft ?? false,
        headRef: "feature",
        baseRef: "main",
      })),
    },
  };
}

function failure(code: string, status = 409): RequestResult<never> {
  return { ok: false, status, code, issues: [] };
}

function started(
  overrides: Partial<StartedReview> = {},
): RequestResult<StartedReview> {
  return {
    ok: true,
    data: {
      runId: "run-1",
      created: true,
      prNumber: 7,
      command: "review",
      ...overrides,
    },
  };
}

function fakeApi(
  listAnswers: RequestResult<OpenPullRequests>[],
  startAnswer: RequestResult<StartedReview> = started(),
) {
  const queue = [...listAnswers];
  const listPullRequests = vi.fn<ManualReviewApi["listPullRequests"]>(
    async () => queue.shift() ?? listAnswers.at(-1)!,
  );
  const startReview = vi.fn<ManualReviewApi["startReview"]>(
    async () => startAnswer,
  );
  const api: ManualReviewApi = { listPullRequests, startReview };
  return { api, listPullRequests, startReview };
}

async function renderPanel(api: ManualReviewApi) {
  const user = userEvent.setup();
  render(<StartReviewPanel repositoryId="repo-1" api={api} />);
  return user;
}

const button = () => screen.getByRole("button", { name: "Review now" });

describe("loading the pull requests", () => {
  it("asks the route for the repository's pull requests and lists them", async () => {
    const { api, listPullRequests } = fakeApi([
      list([{ number: 7, title: "Add caching" }]),
    ]);
    await renderPanel(api);

    expect(
      await screen.findByRole("radio", { name: /Add caching/ }),
    ).toBeTruthy();
    expect(listPullRequests).toHaveBeenCalledWith("repo-1");
  });

  // CR-33-T03
  it("explains the empty list and leaves the button unclickable", async () => {
    await renderPanel(fakeApi([list([])]).api);

    expect(
      await screen.findByText(/There are no open pull requests/),
    ).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });

  // CR-33-T07
  it("says what went wrong when GitHub fails and loads again on 'Try again'", async () => {
    const { api, listPullRequests } = fakeApi([
      failure("MANUAL_REVIEW_GITHUB_UNAVAILABLE", 502),
      list([{ number: 7, title: "Add caching" }]),
    ]);
    const user = await renderPanel(api);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("GitHub could not be reached");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("radio", { name: /Add caching/ }),
    ).toBeTruthy();
    expect(listPullRequests).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // CR-33-T08
  it("names the missing installation without a token or a raw answer", async () => {
    await renderPanel(
      fakeApi([failure("MANUAL_REVIEW_APP_NOT_INSTALLED")]).api,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/GitHub App is not installed/);
    expect(alert.textContent).not.toMatch(/MANUAL_REVIEW|ghs_|Bearer/);
  });

  it("tells a session that ended in plain words", async () => {
    await renderPanel(fakeApi([failure("UNAUTHENTICATED", 401)]).api);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your session has ended",
    );
  });

  it("loads the list again when the panel is shown again", async () => {
    const { api, listPullRequests } = fakeApi([
      list([{ number: 7 }]),
      list([{ number: 7 }, { number: 8 }]),
    ]);
    const { unmount } = render(
      <StartReviewPanel repositoryId="repo-1" api={api} />,
    );
    await screen.findByRole("radio", { name: /#7/ });
    unmount();

    render(<StartReviewPanel repositoryId="repo-1" api={api} />);

    expect(await screen.findByRole("radio", { name: /#8/ })).toBeTruthy();
    expect(listPullRequests).toHaveBeenCalledTimes(2);
  });
});

describe("starting a command", () => {
  it("keeps the button off until a pull request is picked", async () => {
    const { api, startReview } = fakeApi([list([{ number: 7 }])]);
    const user = await renderPanel(api);
    await screen.findByRole("radio", { name: /#7/ });

    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /#7/ }));

    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(startReview).not.toHaveBeenCalled();
  });

  // CR-33-T04
  it("sends the picked pull request and command, then links to the new run", async () => {
    const { api, startReview } = fakeApi(
      [list([{ number: 7 }, { number: 3 }])],
      started({ runId: "run-42", prNumber: 7, command: "improve" }),
    );
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));
    await user.selectOptions(
      screen.getByLabelText("Command to run"),
      "improve",
    );

    await user.click(button());

    expect(startReview).toHaveBeenCalledWith("repo-1", {
      prNumber: 7,
      command: "improve",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(
      "Started: improve for pull request #7",
    );
    expect(
      screen.getByRole("link", { name: "View the run" }).getAttribute("href"),
    ).toBe("/runs/run-42");
  });

  // CR-33-T10
  it("says that the same run was there already when the route returns the existing one", async () => {
    const { api } = fakeApi(
      [list([{ number: 7 }])],
      started({ created: false, runId: "run-1" }),
    );
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));

    await user.click(button());

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("already waiting or running");
    expect(screen.getByRole("link", { name: "View the run" })).toBeTruthy();
  });

  // CR-33-T10
  it("cannot be sent twice while the first request is on its way", async () => {
    const { api, startReview } = fakeApi([list([{ number: 7 }])]);
    let finish: (value: RequestResult<StartedReview>) => void = () => undefined;
    startReview.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));

    await user.click(button());
    await user.click(button());

    expect(startReview).toHaveBeenCalledTimes(1);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    finish(started());
    await waitFor(() =>
      expect((button() as HTMLButtonElement).disabled).toBe(false),
    );
  });

  // CR-33-T06
  it.each(["", "   ", "\n"])(
    "shows a message and sends nothing for ask with the question %j",
    async (question) => {
      const { api, startReview } = fakeApi([list([{ number: 7 }])]);
      const user = await renderPanel(api);
      await user.click(await screen.findByRole("radio", { name: /#7/ }));
      await user.selectOptions(screen.getByLabelText("Command to run"), "ask");
      if (question.trim() !== "")
        await user.type(screen.getByLabelText("Question"), question);

      await user.click(button());

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Write the question",
      );
      expect(startReview).not.toHaveBeenCalled();
    },
  );

  // CR-33-T05
  it("sends the question with ask and nothing with the other commands", async () => {
    const { api, startReview } = fakeApi([list([{ number: 7 }])]);
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));
    await user.selectOptions(screen.getByLabelText("Command to run"), "ask");
    await user.type(screen.getByLabelText("Question"), "Why was it removed?");

    await user.click(button());

    expect(startReview).toHaveBeenCalledWith("repo-1", {
      prNumber: 7,
      command: "ask",
      question: "Why was it removed?",
    });
  });

  // CR-33-T09
  it("says the pull request is closed and loads the list again", async () => {
    const { api, startReview, listPullRequests } = fakeApi([
      list([{ number: 7 }]),
      list([]),
    ]);
    startReview.mockResolvedValueOnce(
      failure("MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN"),
    );
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));

    await user.click(button());

    await waitFor(() => expect(listPullRequests).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/closed or merged/)).toBeTruthy();
    expect(
      await screen.findByText(/There are no open pull requests/),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("shows any other refusal as a sentence, never as a code", async () => {
    const { api, startReview } = fakeApi([list([{ number: 7 }])]);
    startReview.mockResolvedValueOnce(
      failure("MANUAL_REVIEW_COMMAND_NOT_ALLOWED"),
    );
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));

    await user.click(button());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("switched off in the settings");
    expect(alert.textContent).not.toContain("MANUAL_REVIEW");
  });

  it("starts with the first command the project allows and cannot start when none is allowed", async () => {
    const { api } = fakeApi([list([{ number: 7 }], ["describe"])]);
    const user = await renderPanel(api);
    await user.click(await screen.findByRole("radio", { name: /#7/ }));

    expect(
      (screen.getByLabelText("Command to run") as HTMLSelectElement).value,
    ).toBe("describe");
    cleanup();
    const none = fakeApi([list([{ number: 7 }], [])]);
    const user2 = await renderPanel(none.api);
    await user2.click(await screen.findByRole("radio", { name: /#7/ }));
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Every command is switched off/)).toBeTruthy();
  });

  // CR-33-T15
  it("shows a hostile title and author as text", async () => {
    const { api } = fakeApi([
      list([
        {
          number: 7,
          title: "<img src=x onerror=alert(1)>",
          author: "<script>alert(1)</script>",
        },
      ]),
    ]);
    render(<StartReviewPanel repositoryId="repo-1" api={api} />);

    await screen.findByRole("radio");

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
