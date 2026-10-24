// SPDX-License-Identifier: LicenseRef-Proprietary

// What the call trace tables say (#541): the headings, the words for why a call ended, and the notes. The
// words describe numbers and stable names only; the trace holds no text from the repository or the model.
// Shared by the Runs detail of a workspace and the job view of the admin portal.
import type { TraceFinishReason } from "../../runner-api/contract.ts";

export const CALL_TRACE_COPY = {
  title: "Call trace",
  intro:
    "What each call of this review was: sizes, counts and times only, never paths, arguments or text.",
  modelCallsTitle: "Model calls",
  toolCallsTitle: "Tool calls",
  noModelCalls: "No model call was recorded.",
  noToolCalls: "No tool call was recorded.",
  truncated:
    "The trace holds the first 100 model calls and the first 100 tool calls; the run made more.",
  notAvailable: "n/a",
  none: "None",
  no: "No",
  repeat: "Repeat",
  finalCall: "final call",
  columns: {
    number: "#",
    started: "Started",
    prompt: "Prompt",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    output: "Output",
    cost: "Cost",
    ended: "Ended",
    tools: "Tools",
    tool: "Tool",
    result: "Result",
    repeat: "Repeat",
  },
} as const;

/** Why a model call ended, in words. */
export const FINISH_REASON_TEXT: Record<TraceFinishReason, string> = {
  stop: "Stopped",
  tool_calls: "Tool calls",
  length: "Cut off at the output limit",
  content_filter: "Content filter",
  other: "Other",
};

/** "1 of 4 tool calls repeated an earlier call." */
export function repeatsText(repeats: number, total: number): string {
  const calls = total === 1 ? "tool call" : "tool calls";
  return `${repeats} of ${total} ${calls} repeated an earlier call.`;
}
