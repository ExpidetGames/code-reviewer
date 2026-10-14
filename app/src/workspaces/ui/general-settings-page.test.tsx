// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "General" sub-page of the workspace settings (#178): the rename (an Owner) or the
// read-only name (everybody else), the read-only instance, tenancy and member facts, and the one
// "Needs attention" strip that carries the configuration hints and the workspace's LLM hint. A member
// reads no variable name and no value.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
}));

import {
  describeConfigStatus,
  statusForMembers,
  type ConfigAudience,
  type ConfigStatus,
  type GithubAppStatus,
} from "../../config-status/status.ts";
import type { WorkspaceLlmSummary } from "../../llm/assemble.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import { GeneralSettingsPageContent } from "./general-settings-page.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
  navigation.replace.mockClear();
  // The redirect test sets a hash; leave the next test a clean address.
  window.history.replaceState(null, "", "/");
});

const LLM_KEY = "dummy-llm-key-0123456789";
const MISSING_GITHUB: GithubAppStatus = {
  configured: false,
  kind: "missing",
  variables: ["app_id"],
  slug: null,
};
const WORKS: WorkspaceLlmSummary = { configured: true, source: "workspace" };
const MISSING: WorkspaceLlmSummary = { configured: false, reason: "no_key" };

function general({
  config = describeConfigStatus({}, testGithubAppStatus()),
  audience = "operator" as ConfigAudience,
  canRename = true,
  llmSummary = WORKS,
}: {
  config?: ConfigStatus;
  audience?: ConfigAudience;
  canRename?: boolean;
  llmSummary?: WorkspaceLlmSummary;
} = {}) {
  return render(
    <GeneralSettingsPageContent
      workspaceSlug="acme"
      workspaceName="Acme"
      canRename={canRename}
      canManageLlmKey
      audience={audience}
      tenancy="multi"
      memberCount={4}
      config={config}
      llmSummary={llmSummary}
    />,
  );
}

describe("the General settings sub-page", () => {
  // #178-T01
  it("shows General at the settings index with exactly one form, the rename", () => {
    const { container } = general();

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Workspace name",
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getByRole("link", { name: "General" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("reads the instance, tenancy and member facts", () => {
    general();

    expect(screen.getByText("Tenancy")).toBeTruthy();
    expect(screen.getByText("Multi-tenant")).toBeTruthy();
    expect(screen.getByText("Members")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText(/Configured/)).toBeTruthy();
  });

  it("has one Needs attention strip that carries the configuration hints and the LLM hint", () => {
    general({
      config: describeConfigStatus({}, MISSING_GITHUB),
      llmSummary: MISSING,
    });

    const regions = screen.getAllByRole("region", { name: "Needs attention" });
    expect(regions).toHaveLength(1);
    expect(
      within(regions[0]!).getByText("GitHub App not configured"),
    ).toBeTruthy();
    expect(within(regions[0]!).getByText("LLM not configured")).toBeTruthy();
    // The static rows carry no alert role.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #178-T01
  it("gives a member no form and only the read-only name, with no variable name or value", () => {
    const { container } = general({
      config: statusForMembers(describeConfigStatus({}, MISSING_GITHUB)),
      audience: "member",
      canRename: false,
    });

    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(screen.getByText(/Only an Owner can rename it\./)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/GITHUB_APP|LLM_|openrouter|Missing:/);
    expect(text).not.toContain(LLM_KEY);
  });

  it("shows no hint while the configuration is complete and never a key", () => {
    const { container } = general();

    expect(
      screen.queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
    expect(container.textContent).not.toContain(LLM_KEY);
  });

  // #178 review N3
  it("sends an old `#llm-access` bookmark on to the LLM sub-page", async () => {
    window.history.replaceState(null, "", "#llm-access");

    general();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/w/acme/settings/llm"),
    );
  });
});
