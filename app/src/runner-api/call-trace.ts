// SPDX-License-Identifier: Apache-2.0

// The per-call trace of a Dynamic Review (#541), checked against `RunnerCallTrace` of
// `contracts/runner-api.v1.json`: exactly the contract's shape or nothing. A runner sends it, the app
// stores it with the result, and the Runs views read it back with the same check, so a stored value that
// is not the contract's (an older shape, a hand-edited row) is never shown. Pure and free of server-only
// code: the views of the browser use it too. It names no value of what it refuses.
import type {
  RunnerCallTrace,
  RunnerModelCallTrace,
  RunnerToolCallTrace,
} from "./contract.ts";
import {
  MAX_TRACE_ENTRIES,
  TRACE_FINISH_REASONS,
  TRACE_TOOL_NAMES,
} from "./contract.ts";

const MAX_COUNT = 1_000_000_000;
const MAX_MS = 604_800_000;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the object has exactly these keys, no more and no fewer. */
function hasExactly(value: Record_, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => key in value);
}

function whole(value: unknown, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

function wholeOrNull(value: unknown, max: number): value is number | null {
  return value === null || whole(value, max);
}

function isToolName(value: unknown): boolean {
  return (TRACE_TOOL_NAMES as readonly unknown[]).includes(value);
}

const MODEL_CALL_KEYS = [
  "index",
  "tMs",
  "promptTokens",
  "cacheRead",
  "cacheWrite",
  "completionTokens",
  "costUsd",
  "finishReason",
  "final",
  "tools",
] as const;
const TOOL_CALL_KEYS = ["index", "name", "resultBytes", "isRepeat"] as const;

function modelCall(value: unknown): RunnerModelCallTrace | undefined {
  if (!isRecord(value) || !hasExactly(value, MODEL_CALL_KEYS)) return undefined;
  const { costUsd, finishReason, tools } = value;
  const costOk =
    costUsd === null ||
    (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0);
  const finishOk =
    finishReason === null ||
    (TRACE_FINISH_REASONS as readonly unknown[]).includes(finishReason);
  if (!Array.isArray(tools) || tools.length > TRACE_TOOL_NAMES.length)
    return undefined;
  for (const tool of tools as unknown[]) {
    if (
      !isRecord(tool) ||
      !hasExactly(tool, ["name", "count"]) ||
      !isToolName(tool.name) ||
      !whole(tool.count, MAX_COUNT) ||
      tool.count < 1
    )
      return undefined;
  }
  if (
    !whole(value.index, MAX_COUNT) ||
    !whole(value.tMs, MAX_MS) ||
    !wholeOrNull(value.promptTokens, MAX_COUNT) ||
    !wholeOrNull(value.cacheRead, MAX_COUNT) ||
    !wholeOrNull(value.cacheWrite, MAX_COUNT) ||
    !wholeOrNull(value.completionTokens, MAX_COUNT) ||
    !costOk ||
    !finishOk ||
    typeof value.final !== "boolean"
  )
    return undefined;
  return value as unknown as RunnerModelCallTrace;
}

function toolCall(value: unknown): RunnerToolCallTrace | undefined {
  if (!isRecord(value) || !hasExactly(value, TOOL_CALL_KEYS)) return undefined;
  if (
    !whole(value.index, MAX_COUNT) ||
    !isToolName(value.name) ||
    !wholeOrNull(value.resultBytes, MAX_RESULT_BYTES) ||
    typeof value.isRepeat !== "boolean"
  )
    return undefined;
  return value as unknown as RunnerToolCallTrace;
}

/**
 * The trace as the contract has it, or `undefined` when `value` is not one. Nothing is repaired or
 * dropped: a trace with one bad entry is refused whole.
 */
export function checkCallTrace(value: unknown): RunnerCallTrace | undefined {
  if (
    !isRecord(value) ||
    !hasExactly(value, ["truncated", "modelCalls", "toolCalls"]) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.modelCalls) ||
    !Array.isArray(value.toolCalls) ||
    value.modelCalls.length > MAX_TRACE_ENTRIES ||
    value.toolCalls.length > MAX_TRACE_ENTRIES
  )
    return undefined;
  if (!(value.modelCalls as unknown[]).every((call) => modelCall(call)))
    return undefined;
  if (!(value.toolCalls as unknown[]).every((call) => toolCall(call)))
    return undefined;
  return value as unknown as RunnerCallTrace;
}
