// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the configuration hints the pages show: nothing while everything works, a visible hint
// naming the variable (never a value) when the LLM key or the GitHub App settings are wrong, and
// the same stable codes always giving the same copy.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLM_CONFIG_ISSUE_CODES,
  type LlmConfigIssueCode,
} from "../llm/config.ts";
import { ConfigNotices } from "./notices.tsx";
import { describeConfigNotices, LLM_ISSUE_COPY } from "./notices.ts";
import type { ConfigStatus } from "./status.ts";

afterEach(cleanup);

const WORKING: ConfigStatus = {
  githubApp: { configured: true, slug: "code-reviewer" },
  llm: {
    configured: true,
    provider: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    warnings: [],
  },
};

describe("the configuration hints", () => {
  // CR-34-T11
  it("show nothing when every value is there", () => {
    const { container } = render(<ConfigNotices status={WORKING} />);

    expect(container.textContent).toBe("");
    expect(describeConfigNotices(WORKING)).toEqual([]);
  });

  // #104-LK-13 (the LLM access is a matter of the workspace now; its hint is src/llm/ui/llm-access-notice.tsx)
  it("do not call an absent LLM variable a problem of the instance", () => {
    const status: ConfigStatus = {
      ...WORKING,
      llm: {
        configured: false,
        issues: [
          { code: "LLM_PROVIDER_MISSING", variable: "LLM_PROVIDER" },
          { code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" },
        ],
        warnings: [],
      },
    };

    expect(describeConfigNotices(status, "operator")).toEqual([]);
    expect(describeConfigNotices(status)).toEqual([]);
  });

  // #104-LK-12
  it("tell the instance admin about a key without a provider, which the fallback does not use", () => {
    const notices = describeConfigNotices(
      {
        ...WORKING,
        llm: {
          configured: false,
          issues: [{ code: "LLM_PROVIDER_MISSING", variable: "LLM_PROVIDER" }],
          warnings: [],
        },
      },
      "operator",
    );

    expect(notices).toMatchObject([{ id: "LLM_PROVIDER_MISSING" }]);
    expect(notices[0]?.detail).toContain("LLM_PROVIDER");
  });

  it("still tell the instance admin about a legacy LLM variable that is set but wrong", () => {
    render(
      <ConfigNotices
        status={{
          ...WORKING,
          llm: {
            configured: false,
            issues: [{ code: "LLM_API_KEY_INVALID", variable: "LLM_API_KEY" }],
            warnings: [],
          },
        }}
        audience="operator"
      />,
    );

    expect(screen.getByText("LLM key not valid")).toBeTruthy();
    expect(screen.getByText(/LLM_API_KEY/)).toBeTruthy();
  });

  // CR-34-T10
  it("name each missing GitHub App variable and explain that activating is off", () => {
    render(
      <ConfigNotices
        status={{
          ...WORKING,
          githubApp: {
            configured: false,
            kind: "missing",
            variables: ["GITHUB_APP_ID", "GITHUB_APP_WEBHOOK_SECRET"],
            slug: null,
          },
        }}
        audience="operator"
      />,
    );

    expect(screen.getByText("GitHub App not configured")).toBeTruthy();
    const detail = screen.getByText(/GITHUB_APP_ID/);
    expect(detail.textContent).toContain("GITHUB_APP_WEBHOOK_SECRET");
    expect(detail.textContent).toMatch(/cannot be activated/i);
  });

  it("separate a variable that is wrong from one that is missing", () => {
    const notices = describeConfigNotices(
      {
        ...WORKING,
        githubApp: {
          configured: false,
          kind: "invalid",
          variables: ["GITHUB_APP_PRIVATE_KEY"],
          slug: null,
        },
      },
      "operator",
    );

    expect(notices).toMatchObject([
      { id: "github_app", title: "GitHub App settings not valid" },
    ]);
  });

  it("show a wrong optional LLM variable as a warning next to a working configuration", () => {
    const notices = describeConfigNotices(
      {
        ...WORKING,
        llm: {
          configured: true,
          provider: "openrouter",
          model: "anthropic/claude-haiku-5.5",
          warnings: [{ code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" }],
        },
      },
      "operator",
    );

    expect(notices).toMatchObject([{ severity: "warning" }]);
  });

  it("have copy for every LLM configuration code", () => {
    for (const code of LLM_CONFIG_ISSUE_CODES) {
      const copy = LLM_ISSUE_COPY[code as LlmConfigIssueCode];
      expect(copy.title, code).not.toBe("");
      expect(copy.title, code).not.toBe(code);
    }
  });

  // #101-WM-08
  it("tell a member that a part is not set up and who to ask, naming no variable and no setting", () => {
    const broken: ConfigStatus = {
      githubApp: {
        configured: false,
        kind: "missing",
        variables: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
        slug: null,
      },
      llm: {
        configured: false,
        issues: [{ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" }],
        warnings: [{ code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" }],
      },
    };

    const { container } = render(<ConfigNotices status={broken} />);

    expect(screen.getByText("GitHub is not set up yet")).toBeTruthy();
    expect(container.textContent).toContain("Ask your instance admin");
    expect(container.textContent).not.toMatch(/GITHUB_APP|LLM_|private key/i);
    expect(describeConfigNotices(broken)).toHaveLength(1);
  });

  // #101-WM-08
  it("show a member nothing about a setting that is ignored while everything works", () => {
    const { container } = render(
      <ConfigNotices
        status={{
          ...WORKING,
          llm: {
            configured: true,
            provider: "openrouter",
            model: "anthropic/claude-haiku-5.5",
            warnings: [{ code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" }],
          },
        }}
      />,
    );

    expect(container.textContent).toBe("");
  });
});
