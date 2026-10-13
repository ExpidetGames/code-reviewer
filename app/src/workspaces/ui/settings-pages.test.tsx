// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the shape of the workspace settings sub-pages (#178): each is its own screen with the
// settings sub-nav marking it, and no page stacks independent forms — one form on "General"
// (rename), "Review defaults" and "LLM access", and "Advanced" only holds destructive actions, so no
// form at all (issue target design: "actions only"). The behaviour of each form is pinned in its own
// file; this one pins the split.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
}));

import { estimateReviewCost } from "../../review-settings/cost.ts";
import { modelFromGlobalView } from "../../review-settings/ui/form-model.ts";
import { GlobalSettingsPageContent } from "../../review-settings/ui/global-settings-page.tsx";
import {
  builtInReviewSettings,
  type ReviewSettingField,
} from "../../review-settings/settings.ts";
import {
  describeConfigStatus,
  type ConfigStatus,
} from "../../config-status/status.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import { LlmSettingsPageContent } from "../../llm/ui/llm-settings-page.tsx";
import { AdvancedSettingsPageContent } from "./advanced-settings-page.tsx";
import { GeneralSettingsPageContent } from "./general-settings-page.tsx";

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const GLOBAL_DATA = {
  model: modelFromGlobalView({
    overrides: {},
    effective: BUILT_IN,
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as Record<ReviewSettingField, "built_in">,
    cost: estimateReviewCost(BUILT_IN),
    builtIn: BUILT_IN,
    updatedAt: null,
    updatedBy: null,
  }),
};

function workingConfig(): ConfigStatus {
  return describeConfigStatus({}, testGithubAppStatus());
}

const WORKS = { configured: true, source: "workspace" } as const;

const renders = [
  {
    key: "general",
    label: "General",
    element: (
      <GeneralSettingsPageContent
        workspaceSlug="acme"
        workspaceName="Acme"
        canRename
        canManageLlmKey
        audience="operator"
        tenancy="multi"
        memberCount={2}
        config={workingConfig()}
        llmSummary={WORKS}
      />
    ),
    forms: 1,
  },
  {
    key: "review-defaults",
    label: "Review defaults",
    element: (
      <GlobalSettingsPageContent workspaceSlug="acme" data={GLOBAL_DATA} />
    ),
    forms: 1,
  },
  {
    key: "llm",
    label: "LLM access",
    element: (
      <LlmSettingsPageContent
        workspaceSlug="acme"
        canManage
        keyStatus={{ state: "not_configured" }}
        summary={{ configured: false, reason: "no_key" }}
      />
    ),
    forms: 1,
  },
  {
    key: "advanced",
    label: "Advanced",
    element: (
      <AdvancedSettingsPageContent
        workspaceSlug="acme"
        canManageKey
        keyConfigured
        canResetDefaults
      />
    ),
    forms: 0,
  },
];

describe("the workspace settings sub-pages", () => {
  // #178-T02
  it("each renders its own screen with the sub-nav marking it and at most one form", () => {
    for (const { key, label, element, forms } of renders) {
      const { container, unmount } = render(<div key={key}>{element}</div>);

      expect(container.querySelectorAll("form"), label).toHaveLength(forms);
      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      expect(
        within(nav)
          .getByRole("link", { name: label })
          .getAttribute("aria-current"),
        label,
      ).toBe("page");
      expect(within(nav).getAllByRole("link")).toHaveLength(4);
      unmount();
    }
  });
});
