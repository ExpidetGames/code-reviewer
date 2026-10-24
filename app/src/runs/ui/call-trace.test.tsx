// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the table view of the call trace of a run (#541): one row per model call and per tool call,
// numbers and stable words only, the cost column only where the cost may be shown, and a clear note when
// the trace was cut at its cap.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunnerCallTrace,
  RunnerModelCallTrace,
} from "../../runner-api/contract.ts";
import { CallTraceTables } from "./call-trace.tsx";
import { CALL_TRACE_COPY } from "./call-trace-messages.ts";

afterEach(cleanup);

const modelCall: RunnerModelCallTrace = {
  index: 0,
  tMs: 1200,
  promptTokens: 14_600,
  cacheRead: 0,
  cacheWrite: 14_600,
  completionTokens: 492,
  costUsd: 0.0342,
  finishReason: "tool_calls",
  final: false,
  tools: [
    { name: "read", count: 2 },
    { name: "grep", count: 1 },
  ],
};

function trace(overrides: Partial<RunnerCallTrace> = {}): RunnerCallTrace {
  return {
    truncated: false,
    modelCalls: [
      modelCall,
      {
        ...modelCall,
        index: 1,
        tMs: 61_500,
        promptTokens: 15_380,
        cacheRead: 14_600,
        cacheWrite: 780,
        costUsd: 0.0089,
        finishReason: "stop",
        final: true,
        tools: [],
      },
    ],
    toolCalls: [
      { index: 0, name: "read", resultBytes: 2_048, isRepeat: false },
      { index: 1, name: "read", resultBytes: 2_048, isRepeat: true },
      {
        index: 2,
        name: "StructuredOutput",
        resultBytes: null,
        isRepeat: false,
      },
      { index: 3, name: "other", resultBytes: 0, isRepeat: false },
    ],
    ...overrides,
  };
}

const rowsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

describe("the call trace tables", () => {
  // #541-T09
  it("has a table of the model calls with the tokens, the cache, the output, the cost and why each ended", () => {
    render(<CallTraceTables trace={trace()} showProviderDetail />);

    const table = screen.getByRole("table", {
      name: CALL_TRACE_COPY.modelCallsTitle,
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "#",
      "Started",
      "Prompt",
      "Cache read",
      "Cache write",
      "Output",
      "Cost",
      "Ended",
      "Tools",
    ]);
    expect(rowsOf(table)).toEqual([
      [
        "1",
        "1.2 s",
        "14,600",
        "0",
        "14,600",
        "492",
        "$0.0342",
        "Tool calls",
        "read ×2, grep",
      ],
      [
        "2",
        "1 min 1.5 s",
        "15,380",
        "14,600",
        "780",
        "492",
        "$0.0089",
        "Stopped · final call",
        "None",
      ],
    ]);
  });

  // #541-T09
  it("has a table of the tool calls with the size of the result and whether the call was a repeat", () => {
    render(<CallTraceTables trace={trace()} showProviderDetail />);

    const table = screen.getByRole("table", {
      name: CALL_TRACE_COPY.toolCallsTitle,
    });
    expect(rowsOf(table)).toEqual([
      ["1", "read", "2 KiB", "No"],
      ["2", "read", "2 KiB", "Repeat"],
      ["3", "StructuredOutput", "None", "No"],
      ["4", "other", "0 B", "No"],
    ]);
  });

  // #541-T09
  it("counts the repeats", () => {
    render(<CallTraceTables trace={trace()} showProviderDetail />);

    expect(
      screen.getByText("1 of 4 tool calls repeated an earlier call."),
    ).toBeTruthy();
  });

  // #541-T10
  it("leaves the cost column out where the cost is not shown", () => {
    const { container } = render(
      <CallTraceTables trace={trace()} showProviderDetail={false} />,
    );

    const table = screen.getByRole("table", {
      name: CALL_TRACE_COPY.modelCallsTitle,
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).not.toContain("Cost");
    expect(container.textContent).not.toContain("$");
  });

  // #541-T10: whether a provider reports a cache write at all says which provider it is, so a run on
  // the operator's key shows no cache columns either.
  it("leaves the cache columns out as well where the provider detail is not shown", () => {
    render(<CallTraceTables trace={trace()} showProviderDetail={false} />);

    const table = screen.getByRole("table", {
      name: CALL_TRACE_COPY.modelCallsTitle,
    });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).not.toContain(CALL_TRACE_COPY.columns.cacheRead);
    expect(headers).not.toContain(CALL_TRACE_COPY.columns.cacheWrite);
    expect(rowsOf(table)[0]).toHaveLength(headers.length);
  });

  // #541-T09
  it("shows an unknown count as not available, never as zero", () => {
    render(
      <CallTraceTables
        trace={trace({
          modelCalls: [
            {
              ...modelCall,
              promptTokens: null,
              cacheRead: null,
              cacheWrite: null,
              completionTokens: null,
              costUsd: null,
              finishReason: null,
              tools: [],
            },
          ],
        })}
        showProviderDetail
      />,
    );

    const table = screen.getByRole("table", {
      name: CALL_TRACE_COPY.modelCallsTitle,
    });
    expect(rowsOf(table)).toEqual([
      ["1", "1.2 s", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "None"],
    ]);
  });

  // #541-T09
  it("says that the trace was cut when it was", () => {
    render(
      <CallTraceTables trace={trace({ truncated: true })} showProviderDetail />,
    );

    expect(screen.getByText(CALL_TRACE_COPY.truncated)).toBeTruthy();
  });

  // #541-T09
  it("says so when a run made no tool call or no model call", () => {
    render(
      <CallTraceTables
        trace={trace({ modelCalls: [], toolCalls: [] })}
        showProviderDetail
      />,
    );

    expect(screen.getByText(CALL_TRACE_COPY.noModelCalls)).toBeTruthy();
    expect(screen.getByText(CALL_TRACE_COPY.noToolCalls)).toBeTruthy();
  });
});
