// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the instance block of the Settings page: working parts are named with provider and
// model, broken parts with the variable names, and no secret appears in either case.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { testGithubAppEnv } from "../test-support/github-app.ts";
import { InstanceStatus } from "./instance-status.tsx";
import { describeConfigStatus, statusForMembers } from "./status.ts";

afterEach(cleanup);

const LLM_KEY = "dummy-llm-key-0123456789";

describe("the instance status", () => {
  // CR-34-T11
  it("names provider and model when the LLM access works", () => {
    const { container } = render(
      <InstanceStatus
        status={describeConfigStatus({
          LLM_PROVIDER: "openrouter",
          LLM_API_KEY: LLM_KEY,
        })}
        audience="operator"
      />,
    );

    expect(screen.getByText(/Configured: /).textContent).toContain(
      "openrouter",
    );
    expect(screen.getByText("anthropic/claude-haiku-5.5")).toBeTruthy();
    expect(container.textContent).not.toContain(LLM_KEY);
  });

  // CR-34-T09, CR-34-T10
  it("names the variables of the parts that are not configured", () => {
    const { container } = render(
      <InstanceStatus
        status={describeConfigStatus({ LLM_PROVIDER: "openrouter" })}
        audience="operator"
      />,
    );

    expect(screen.getByText("LLM_API_KEY")).toBeTruthy();
    expect(container.textContent).toMatch(/Missing:.*GITHUB_APP_ID/);
  });

  // #101-WM-08
  it("tells a member only whether each part is set up, with no variable, provider, model or slug", () => {
    const broken = describeConfigStatus({ LLM_PROVIDER: "openrouter" });
    const { container } = render(<InstanceStatus status={broken} />);

    expect(container.textContent).toContain(
      "Not set up yet. Ask your instance admin.",
    );
    expect(container.textContent).not.toMatch(
      /GITHUB_|LLM_|openrouter|Missing/,
    );
  });

  // #101-WM-08
  it("tells a member of a working instance that both parts are set up, and nothing about them", () => {
    const working = describeConfigStatus({
      LLM_PROVIDER: "openrouter",
      LLM_API_KEY: LLM_KEY,
      LLM_MODEL: "vendor/secret-model",
      ...testGithubAppEnv(),
    });
    const { container } = render(<InstanceStatus status={working} />);

    expect(container.textContent).toBe("GitHubSet upReviewsSet up");
    expect(container.textContent).not.toMatch(/secret-model|openrouter/);
  });

  // #101-WM-08
  it("is what the status for members shows even when a part of the page asks for the operator's copy", () => {
    const status = statusForMembers(
      describeConfigStatus({ LLM_PROVIDER: "openrouter" }),
    );
    const { container } = render(
      <InstanceStatus status={status} audience="operator" />,
    );

    expect(container.textContent).not.toMatch(/GITHUB_APP_ID|LLM_API_KEY/);
  });
});
