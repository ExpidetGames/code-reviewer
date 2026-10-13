// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the manual-review page of a project (#174): it renders the "Review now" panel and nothing
// of the review settings — one form, no settings fields, no save button — with the same heading, trail
// and segmented navigation as the settings page. The panel is wired to the repository of the page. A
// project that is not active says why no review can be started by hand and shows no panel (a note,
// never a live alert). The workspace's LLM-key hint is a row of the page's one attention strip, so a
// person who cannot start a review with a working key reads why before pressing the button.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { llmAccessAttention } from "../../llm/ui/llm-access-notice.tsx";
import type { ManualReviewApi } from "../../manual-reviews/ui/api.ts";
import type { ProjectRowView } from "./list-view.ts";
import { ProjectReviewPageContent } from "./project-review-page.tsx";

afterEach(cleanup);

const row: ProjectRowView = {
  repositoryId: "repo-1",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  installation: "acme",
  status: "active",
  switchedOn: true,
  lastRun: null,
};

/** A stand-in for the routes: one open pull request, nothing started. */
function manualReviews() {
  const listPullRequests = vi.fn<ManualReviewApi["listPullRequests"]>(
    async () => ({
      ok: true,
      data: {
        repositoryId: "repo-1",
        fullName: "acme/widgets",
        allowedCommands: ["review"],
        pullRequests: [
          {
            number: 7,
            title: "Add caching",
            url: "https://github.com/acme/widgets/pull/7",
            author: "alice",
            draft: false,
            headRef: "feature",
            baseRef: "main",
          },
        ],
      },
    }),
  );
  const startReview = vi.fn<ManualReviewApi["startReview"]>(async () => ({
    ok: false,
    status: 500,
    code: "UNEXPECTED_RESPONSE",
    issues: [],
  }));
  return {
    api: { listPullRequests, startReview } satisfies ManualReviewApi,
    listPullRequests,
    startReview,
  };
}

function renderPage({
  status = "active" as ProjectRowView["status"],
  llmNotice = null as ReturnType<typeof llmAccessAttention>,
} = {}) {
  const manual = manualReviews();
  const view = render(
    <ProjectReviewPageContent
      workspaceSlug="acme"
      data={{ kind: "ready", row: { ...row, status } }}
      manualReviewApi={manual.api}
      llmNotice={llmNotice}
    />,
  );
  return { ...manual, ...view };
}

describe("the manual review page of a project", () => {
  // #174-T02
  it("renders only the manual review panel, never the review settings", async () => {
    const { container } = renderPage();

    expect(
      await screen.findByRole("radio", { name: /Add caching/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Open pull requests" }),
    ).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review now" })).toBeTruthy();

    // None of the settings form.
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("Token budget")).toBeNull();
    expect(screen.queryByLabelText("Project rules")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save review settings" }),
    ).toBeNull();
    expect(screen.queryByText(/Estimated cost per review/)).toBeNull();
  });

  // #174-T02 (the panel must ask for the repository of this page, never another one)
  it("loads the pull requests of the repository the page is about", async () => {
    const { listPullRequests } = renderPage();

    await screen.findByRole("radio", { name: /Add caching/ });

    expect(listPullRequests).toHaveBeenCalledWith(row.repositoryId);
  });

  it("marks the Review now segment current and keeps the trail from the Projects list", () => {
    renderPage();

    const sections = screen.getByRole("navigation", { name: "Project" });
    expect(
      within(sections)
        .getByRole("link", { name: "Review now" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(sections)
        .getByRole("link", { name: "Settings" })
        .getAttribute("href"),
    ).toBe("/w/acme/projects/repo-1");
    const trail = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Projects" })).toBeTruthy();
    expect(within(trail).getByText("Review now")).toBeTruthy();
  });

  it("starts no review by hand while the project is not active, and says why", () => {
    renderPage({ status: "inactive" });

    expect(
      screen.queryByRole("heading", { name: "Open pull requests" }),
    ).toBeNull();
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(
      /Reviews can be started by hand only while the project is active/,
    );
    // A static explanation is a note, never a live alert.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the workspace's LLM-key hint as one row of the attention strip, linking to the settings", () => {
    renderPage({
      llmNotice: llmAccessAttention({
        workspaceSlug: "acme",
        summary: { configured: false, reason: "no_key" },
        canManage: true,
      }),
    });

    const strip = screen.getByRole("region", { name: "Needs attention" });
    expect(within(strip).getByText("LLM not configured")).toBeTruthy();
    expect(
      within(strip)
        .getByRole("link", { name: "Add a key in the settings" })
        .getAttribute("href"),
    ).toBe("/w/acme/settings#llm-access");
  });

  it("has no attention strip while the workspace has a working LLM key", () => {
    renderPage({ llmNotice: null });

    expect(screen.queryByText("Needs attention")).toBeNull();
  });
});
