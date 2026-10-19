// SPDX-License-Identifier: Apache-2.0

// The call trace of a run (#541) as two plain tables: the model calls with their tokens, cache use, output,
// cost and why each ended, and the tool calls with the size of the result and whether the call repeated an
// earlier one. Numbers and stable words only (the trace holds nothing else); no colour of its own.
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import type {
  RunnerCallTrace,
  RunnerModelCallTrace,
} from "../../runner-api/contract.ts";
import {
  CALL_TRACE_COPY,
  FINISH_REASON_TEXT,
  repeatsText,
} from "./call-trace-messages.ts";

const COUNT = new Intl.NumberFormat("en-US");
const COST = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const COST_PRECISION = 0.0001;
const NA = CALL_TRACE_COPY.notAvailable;

function count(value: number | null): string {
  return value === null ? NA : COUNT.format(value);
}

function cost(value: number | null): string {
  if (value === null) return NA;
  return value > 0 && value < COST_PRECISION
    ? `< ${COST.format(COST_PRECISION)}`
    : COST.format(value);
}

/** Milliseconds since the start of the run: "1.2 s", "1 min 1.5 s". */
function since(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Number((seconds - minutes * 60).toFixed(1))} s`;
}

/** The size of a result: "812 B", "2 KiB", "1.5 MiB". */
function size(bytes: number | null): string {
  if (bytes === null) return CALL_TRACE_COPY.none;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}

function ended(call: RunnerModelCallTrace): string {
  const reason =
    call.finishReason === null ? NA : FINISH_REASON_TEXT[call.finishReason];
  return call.final ? `${reason} · ${CALL_TRACE_COPY.finalCall}` : reason;
}

function tools(call: RunnerModelCallTrace): string {
  if (call.tools.length === 0) return CALL_TRACE_COPY.none;
  return call.tools
    .map((tool) =>
      tool.count === 1 ? tool.name : `${tool.name} ×${tool.count}`,
    )
    .join(", ");
}

const numeric = "text-right tabular-nums";

export function CallTraceTables({
  trace,
  showProviderDetail,
}: {
  trace: RunnerCallTrace;
  /** False where the cost and the cache counts of a call may not be shown (a run on a managed quality level). */
  showProviderDetail: boolean;
}) {
  const columns = CALL_TRACE_COPY.columns;
  const repeats = trace.toolCalls.filter((call) => call.isRepeat).length;
  return (
    <div data-slot="call-trace" className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{CALL_TRACE_COPY.intro}</p>
      {trace.truncated ? (
        <p className="text-sm text-muted-foreground">
          {CALL_TRACE_COPY.truncated}
        </p>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {CALL_TRACE_COPY.modelCallsTitle}
        </h3>
        {trace.modelCalls.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {CALL_TRACE_COPY.noModelCalls}
          </p>
        ) : (
          <Table aria-label={CALL_TRACE_COPY.modelCallsTitle}>
            <TableHeader>
              <TableRow>
                <TableHead className={numeric}>{columns.number}</TableHead>
                <TableHead className={numeric}>{columns.started}</TableHead>
                <TableHead className={numeric}>{columns.prompt}</TableHead>
                {showProviderDetail ? (
                  <>
                    <TableHead className={numeric}>
                      {columns.cacheRead}
                    </TableHead>
                    <TableHead className={numeric}>
                      {columns.cacheWrite}
                    </TableHead>
                  </>
                ) : null}
                <TableHead className={numeric}>{columns.output}</TableHead>
                {showProviderDetail ? (
                  <TableHead className={numeric}>{columns.cost}</TableHead>
                ) : null}
                <TableHead>{columns.ended}</TableHead>
                <TableHead>{columns.tools}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trace.modelCalls.map((call) => (
                <TableRow key={call.index}>
                  <TableCell className={numeric}>{call.index + 1}</TableCell>
                  <TableCell className={numeric}>{since(call.tMs)}</TableCell>
                  <TableCell className={numeric}>
                    {count(call.promptTokens)}
                  </TableCell>
                  {showProviderDetail ? (
                    <>
                      <TableCell className={numeric}>
                        {count(call.cacheRead)}
                      </TableCell>
                      <TableCell className={numeric}>
                        {count(call.cacheWrite)}
                      </TableCell>
                    </>
                  ) : null}
                  <TableCell className={numeric}>
                    {count(call.completionTokens)}
                  </TableCell>
                  {showProviderDetail ? (
                    <TableCell className={numeric}>
                      {cost(call.costUsd)}
                    </TableCell>
                  ) : null}
                  <TableCell>{ended(call)}</TableCell>
                  <TableCell>{tools(call)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {CALL_TRACE_COPY.toolCallsTitle}
        </h3>
        {trace.toolCalls.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {CALL_TRACE_COPY.noToolCalls}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {repeatsText(repeats, trace.toolCalls.length)}
            </p>
            <Table aria-label={CALL_TRACE_COPY.toolCallsTitle}>
              <TableHeader>
                <TableRow>
                  <TableHead className={numeric}>{columns.number}</TableHead>
                  <TableHead>{columns.tool}</TableHead>
                  <TableHead className={numeric}>{columns.result}</TableHead>
                  <TableHead>{columns.repeat}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.toolCalls.map((call) => (
                  <TableRow key={call.index}>
                    <TableCell className={numeric}>{call.index + 1}</TableCell>
                    <TableCell>{call.name}</TableCell>
                    <TableCell className={numeric}>
                      {size(call.resultBytes)}
                    </TableCell>
                    <TableCell>
                      {call.isRepeat
                        ? CALL_TRACE_COPY.repeat
                        : CALL_TRACE_COPY.no}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </section>
    </div>
  );
}
