// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the manual-review page of a project (#174): it renders the "Review now" panel and nothing
// of the review settings — one form, no settings fields, no save button — with the same heading, trail
// and segmented navigation as the settings page. A project that is not active says why no review can
// be started by hand and shows no panel.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
const quietManualReviews: ManualReviewApi = {
  listPullRequests: async () => ({
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
  startReview: async () => ({
    ok: false,
    status: 500,
    code: "UNEXPECTED_RESPONSE",
    issues: [],
  }),
};

function renderPage(status: ProjectRowView["status"] = "active") {
  return render(
    <ProjectReviewPageContent
      workspaceSlug="acme"
      data={{ kind: "ready", row: { ...row, status } }}
      manualReviewApi={quietManualReviews}
    />,
  );
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
    renderPage("inactive");

    expect(
      screen.queryByRole("heading", { name: "Open pull requests" }),
    ).toBeNull();
    expect(
      screen.getByText(
        /Reviews can be started by hand only while the project is active/,
      ),
    ).toBeTruthy();
  });
});
