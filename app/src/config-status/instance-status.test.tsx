// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the instance block of the Settings page: working parts are named with provider and
// model, broken parts with the variable names, and no secret appears in either case.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceStatus } from "./instance-status.tsx";
import { describeConfigStatus } from "./status.ts";

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
      />,
    );

    expect(screen.getByText("LLM_API_KEY")).toBeTruthy();
    expect(container.textContent).toMatch(/Missing:.*GITHUB_APP_ID/);
  });
});
