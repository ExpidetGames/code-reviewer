// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the detail page of a run: the facts, the comment link rules, the error sentence with its
// code, the log notices, text from outside rendered as text, and the polling that stops at the last
// state or goes on after a failed update.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { RunDetailSnapshot, RunDetailView } from "../run-view.ts";
import type { RunsApi } from "./api.ts";
import { DETAIL_POLL_FAILED_TEXT } from "./poll-messages.ts";
import { LOG_SHORTENED_TEXT, NO_LOG_TEXT, RunDetail } from "./run-detail.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function detail(overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    repositoryId: "repo-1",
    project: "acme/widgets",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    command: "review",
    triggerKind: "webhook",
    trigger: "Automatic",
    status: "succeeded",
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: "2026-10-10T12:03:15.000Z",
    durationMs: 185_000,
    problem: null,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    args: "",
    attempts: 0,
    errorCode: null,
    errorCodeKnown: false,
    commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
    commentMissing: false,
    log: { text: "reviewed 3 files", truncated: false },
    supersededBy: null,
    ...overrides,
  };
}

const snap = (run: RunDetailView): RunDetailSnapshot => ({
  generatedAt: "2026-10-10T12:10:00.000Z",
  run,
});

const failure: RequestResult<RunDetailSnapshot> = {
  ok: false,
  status: 500,
  code: "UNEXPECTED_RESPONSE",
  issues: [],
};

function apiAnswering(answers: RequestResult<RunDetailSnapshot>[]) {
  const api = {
    list: vi.fn(),
    detail: vi.fn(async () => answers.shift() ?? failure),
  };
  return api as unknown as RunsApi & { detail: typeof api.detail };
}

const text = (container: HTMLElement) => container.textContent;

describe("the detail page", () => {
  // CR-35-T04
  it("shows pull request, command, trigger, status, times, duration, comment link and log", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Succeeded");
    expect(text(container)).toContain("acme/widgets");
    expect(text(container)).toContain("#7 on GitHub");
    expect(text(container)).toContain("/review");
    expect(text(container)).toContain("Automatic");
    expect(text(container)).toContain("0123456789ab");
    expect(text(container)).toContain("2026-10-10 12:00 UTC");
    expect(text(container)).toContain("3 min 05 s");
    expect(text(container)).toContain("reviewed 3 files");
    const link = screen.getByRole("link", {
      name: "Open the comment on GitHub",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7#issuecomment-9",
    );
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // CR-35-T04
  it("names who started a run by comment or by hand", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({ triggerKind: "comment", trigger: "Comment by alice" }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Comment by alice");
  });

  // CR-35-T04
  it("shows the translated error and the error code of a failed run", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            commentUrl: null,
            errorCode: "git_unavailable",
            errorCodeKnown: true,
            problem: "GitHub could not be reached.",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("GitHub could not be reached.");
    expect(screen.getByText("git_unavailable").tagName).toBe("CODE");
    expect(screen.queryByRole("link", { name: /comment/i })).toBeNull();
  });

  // CR-35-T09
  it("shows an unknown error code with the general sentence and does not fail", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            errorCode: "flux_capacitor",
            errorCodeKnown: false,
            problem: "The run ended with an error this version does not know.",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("does not know");
    expect(screen.getByText("flux_capacitor")).toBeTruthy();
  });

  // CR-35-T10
  it("says the log was shortened, and says when there is no log", () => {
    const shortened = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ log: { text: "tail", truncated: true } }))}
        api={apiAnswering([])}
      />,
    );
    expect(text(shortened.container)).toContain(LOG_SHORTENED_TEXT);
    expect(text(shortened.container)).toContain("tail");
    shortened.unmount();

    const empty = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ log: { text: "", truncated: false } }))}
        api={apiAnswering([])}
      />,
    );
    expect(text(empty.container)).toContain(NO_LOG_TEXT);
    expect(empty.container.querySelector("pre")).toBeNull();
  });

  // CR-35-T13
  it("renders a log with HTML as plain text and runs no script", () => {
    const log =
      "<script>alert(1)</script><img src=x onerror=alert(1)>\n<b>bold</b>";
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            project: "<script>alert(2)</script>",
            args: "<img src=y onerror=alert(3)>",
            command: "ask",
            log: { text: log, truncated: false },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(log);
    expect(text(container)).toContain("<script>alert(2)</script>");
    expect(text(container)).toContain("<img src=y onerror=alert(3)>");
  });

  // CR-53-T01
  it("shows the sentence for a review that outgrew the comment limit together with the link to the review", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            problem:
              "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
            errorCode: "review_state_truncated",
            errorCodeKnown: true,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("grew past GitHub's comment size limit");
    expect(text(container)).toContain("review_state_truncated");
    expect(
      screen
        .getByRole("link", { name: "Open the comment on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/7#issuecomment-9");
  });

  // CR-35-T14
  it("shows no comment link for a run without one, and says the link was not found", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ commentUrl: null, commentMissing: true }))}
        api={apiAnswering([])}
      />,
    );

    expect(screen.queryByRole("link", { name: /comment/i })).toBeNull();
    expect(text(container)).toContain("the link to its comment was not found");
  });

  it("shows a pull request address that is no web address as plain text", () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ prUrl: null }))}
        api={apiAnswering([])}
      />,
    );

    expect(screen.queryByRole("link", { name: "#7 on GitHub" })).toBeNull();
    expect(screen.getByText("#7")).toBeTruthy();
  });

  it("links a replaced run to the newer one and shows lost attempts", () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "superseded",
            supersededBy: "newer-run",
            attempts: 2,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            commentUrl: null,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(
      screen.getByRole("link", { name: "The newer run" }).getAttribute("href"),
    ).toBe("/w/acme/runs/newer-run");
    expect(screen.getByText("Lost attempts")).toBeTruthy();
    expect(screen.getByText("Replaced")).toBeTruthy();
  });
});

describe("polling the detail page", () => {
  async function pass(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // CR-35-T11
  it("follows the run from waiting to running to succeeded and then stops asking", async () => {
    const waiting = detail({
      status: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      commentUrl: null,
      log: { text: "", truncated: false },
    });
    const api = apiAnswering([
      {
        ok: true,
        data: snap({
          ...waiting,
          status: "running",
          startedAt: waiting.createdAt,
          durationMs: 4000,
        }),
      },
      { ok: true, data: snap(detail()) },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(waiting)} api={api} />,
    );
    expect(screen.getByText("Waiting")).toBeTruthy();

    await pass(3000);
    expect(screen.getByText("Running")).toBeTruthy();

    await pass(3000);
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open the comment on GitHub" }),
    ).toBeTruthy();

    await pass(60_000);
    expect(api.detail).toHaveBeenCalledTimes(2);
  });

  // CR-35-T12
  it("keeps the last data on a failed update, says so and tries again", async () => {
    const running = detail({
      status: "running",
      finishedAt: null,
      commentUrl: null,
    });
    const api = apiAnswering([failure, { ok: true, data: snap(detail()) }]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);
    expect(screen.getByRole("status").textContent).toBe(
      DETAIL_POLL_FAILED_TEXT,
    );
    expect(screen.getByText("Running")).toBeTruthy();

    await pass(3000);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Succeeded")).toBeTruthy();
  });

  it("does not ask at all for a run that is settled", async () => {
    const api = apiAnswering([]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(detail())} api={api} />,
    );

    await pass(60_000);

    expect(api.detail).not.toHaveBeenCalled();
  });

  // CR-35-T12
  it("says the session ended and stops asking when the answer is a refusal that asking again cannot fix", async () => {
    const running = detail({ status: "running", finishedAt: null });
    const api = apiAnswering([
      { ok: false, status: 401, code: "UNAUTHENTICATED", issues: [] },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);

    expect(screen.getByRole("status").textContent).toContain(
      "Your session has ended. Sign in again.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "no longer updates",
    );
    await pass(600_000);
    expect(api.detail).toHaveBeenCalledTimes(1);
  });

  it("says the run is gone and stops asking when it was not found", async () => {
    const running = detail({ status: "running", finishedAt: null });
    const api = apiAnswering([
      { ok: false, status: 404, code: "RUN_NOT_FOUND", issues: [] },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);

    expect(screen.getByRole("status").textContent).toContain(
      "This run no longer exists.",
    );
    await pass(600_000);
    expect(api.detail).toHaveBeenCalledTimes(1);
  });
});
