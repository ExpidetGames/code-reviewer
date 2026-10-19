// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The job view of the admin portal (#541): the newest runs of every workspace, and one run with what it
// consumed and the table of its calls. Text that came from outside (a project name) is text.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminRunDetailView, AdminRunRowView } from "../runs-service.ts";
import { AdminRunDetailContent, AdminRunsListContent } from "./runs-page.tsx";
import { ADMIN_RUNS_COPY } from "./runs-messages.ts";

afterEach(cleanup);

const ID = "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11";

const row: AdminRunRowView = {
  id: ID,
  workspaceSlug: "acme",
  workspaceName: "Acme",
  project: "acme/widgets",
  prNumber: 7,
  reviewKind: "dynamic",
  status: "succeeded",
  createdAt: "2026-10-10T12:00:00.000Z",
  durationMs: 185_000,
  errorCode: null,
};

describe("the list of runs", () => {
  // #541-T09
  it("has a row for every run with its workspace, project, kind, status and a link to the run", () => {
    render(<AdminRunsListContent list={{ runs: [row], hasMore: false }} />);

    const table = screen.getByRole("table", {
      name: ADMIN_RUNS_COPY.listTitle,
    });
    const cells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((tr) =>
        within(tr)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(cells).toEqual([
      [
        "acme",
        "6b1f0a52 acme/widgets #7",
        "Dynamic Review",
        "Succeeded",
        "2026-10-10 12:00 UTC",
        "3 min 05 s",
        "",
      ],
    ]);
    expect(
      within(table)
        .getByRole("link", { name: /6b1f0a52/ })
        .getAttribute("href"),
    ).toBe(`/admin/runs/${ID}`);
  });

  // #541-T09
  it("shows the error code of a run that failed", () => {
    render(
      <AdminRunsListContent
        list={{
          runs: [
            { ...row, status: "failed", errorCode: "dynamic_budget_exceeded" },
          ],
          hasMore: false,
        }}
      />,
    );

    expect(screen.getByText("dynamic_budget_exceeded")).toBeTruthy();
  });

  // #541-T09
  it("says so when there is no run, and when more runs exist than are listed", () => {
    const { rerender } = render(
      <AdminRunsListContent list={{ runs: [], hasMore: false }} />,
    );
    expect(screen.getByText(ADMIN_RUNS_COPY.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    rerender(<AdminRunsListContent list={{ runs: [row], hasMore: true }} />);
    expect(screen.getByText(ADMIN_RUNS_COPY.limited)).toBeTruthy();
  });

  // #541-T09
  it("renders a project name as text", () => {
    render(
      <AdminRunsListContent
        list={{
          runs: [{ ...row, project: "<img src=x onerror=alert(1)>/repo" }],
          hasMore: false,
        }}
      />,
    );

    expect(document.querySelector("img")).toBeNull();
  });
});

const detail: AdminRunDetailView = {
  workspaceSlug: "acme",
  workspaceName: "Acme",
  run: {
    id: ID,
    project: "acme/widgets",
    prNumber: 7,
    reviewKind: "dynamic",
    status: "succeeded",
    createdAt: "2026-10-10T12:00:00.000Z",
    durationMs: 185_000,
    costHidden: false,
    errorCode: null,
    usage: {
      model: "vendor/model",
      totalTokens: 12_900,
      aiCalls: 55,
      costUsd: 0.7012,
      stoppedEarly: "cost_limit",
    },
    callTrace: {
      truncated: false,
      modelCalls: [
        {
          index: 0,
          tMs: 1200,
          promptTokens: 14_600,
          cacheRead: 0,
          cacheWrite: 14_600,
          completionTokens: 492,
          costUsd: 0.0342,
          finishReason: "stop",
          final: true,
          tools: [],
        },
      ],
      toolCalls: [
        { index: 0, name: "read", resultBytes: 100, isRepeat: false },
      ],
    },
  },
};

describe("one run", () => {
  // #541-T09
  it("names the workspace and the project, and shows the usage with the cost and the stop reason", () => {
    const { container } = render(<AdminRunDetailContent detail={detail} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "6b1f0a52",
    );
    const content = container.textContent ?? "";
    expect(content).toContain("Acme");
    expect(content).toContain("acme/widgets");
    expect(content).toContain("vendor/model");
    expect(content).toContain("55 model calls");
    expect(content).toContain("$0.7012");
    expect(content).toContain("cost limit");
  });

  // #541-T09
  it("shows the call trace tables, with the cost per call", () => {
    render(<AdminRunDetailContent detail={detail} />);

    expect(screen.getByRole("region", { name: "Call trace" })).toBeTruthy();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByText("$0.0342")).toBeTruthy();
  });

  // #541-T09
  it("says so for a run that has no trace (an older runner), and nothing fails", () => {
    render(
      <AdminRunDetailContent
        detail={{ ...detail, run: { ...detail.run, callTrace: null } }}
      />,
    );

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(ADMIN_RUNS_COPY.noTrace)).toBeTruthy();
  });

  // #541-T09
  it("links back to the list", () => {
    render(<AdminRunDetailContent detail={detail} />);

    expect(
      screen
        .getByRole("link", { name: ADMIN_RUNS_COPY.listTitle })
        .getAttribute("href"),
    ).toBe("/admin/runs");
  });
});
