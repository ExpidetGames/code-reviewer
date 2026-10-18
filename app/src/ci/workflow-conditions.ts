// SPDX-License-Identifier: Apache-2.0

// Decides which jobs of a workflow run, from the `if` expressions and the `needs` of the YAML, so that a test can say
// "when the snapshot job is skipped and everything else succeeds, the promotion runs" instead of matching text. Test
// support only: it is not imported by any application code.
//
// It models the rule that bit the production pipeline (#480): a job whose `if` has no status function gets an implicit
// `success()`, and that check looks at every job it depends on, directly or through other jobs, so a job skipped
// anywhere up the chain skips it too. Only the syntax the pipeline uses is supported (`&&`, `||`, `!`, `==`, `!=`,
// parentheses, string literals, `needs.<job>.result`, `needs.<job>.outputs.<name>`, `github.<name>`, `cancelled()` and
// `always()`); anything else throws, so a new construct cannot slip by unmodelled.
import type { Job, Workflow } from "./workflow-support.ts";
import { needsOf } from "./workflow-support.ts";

type Value = string | boolean;

export type JobResult = "success" | "failure" | "skipped" | "cancelled";

export type Scenario = {
  /** The outputs the jobs report, by job name (`needs.<job>.outputs.<name>`). */
  outputs?: Record<string, Record<string, string>>;
  /** Jobs that fail when they run; every other job that runs succeeds. */
  failing?: string[];
  /** Jobs the run is cancelled in: they end `cancelled`, and `cancelled()` is true for every job after them. */
  cancelling?: string[];
  /** The run was cancelled before it started. */
  cancelled?: boolean;
};

const GITHUB: Record<string, string> = {
  repository: "ExpidetGames/code-reviewer",
  ref: "refs/heads/main",
};

const TOKEN =
  /\s*(&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[a-z]+\(\)|[A-Za-z_][\w.-]*)/y;
// `success()` is left out on purpose: it is the check every job gets implicitly, so naming it switches nothing off.
// `failure()` switches it off, and `evaluate` throws on it until a condition of the pipeline needs it modelled.
const STATUS_FUNCTIONS = ["cancelled()", "always()", "failure()"];

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let consumed = 0;
  for (;;) {
    const match = TOKEN.exec(expression);
    if (!match) break;
    tokens.push(match[1] as string);
    consumed = TOKEN.lastIndex;
  }
  if (expression.slice(consumed).trim() !== "")
    throw new Error(
      `cannot read the expression near: ${expression.slice(consumed)}`,
    );
  return tokens;
}

function strip(condition: string): string {
  const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  return (match ? (match[1] as string) : condition).trim();
}

function truthy(value: Value): boolean {
  return typeof value === "boolean" ? value : value !== "";
}

function same(left: Value, right: Value): boolean {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

type Context = {
  results: Record<string, JobResult>;
  outputs: Record<string, Record<string, string>>;
  cancelled: boolean;
};

function evaluate(tokens: string[], context: Context): Value {
  let position = 0;
  const peek = () => tokens[position];
  const take = () => {
    const token = tokens[position];
    if (token === undefined) throw new Error("the expression ends too early");
    position += 1;
    return token;
  };

  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const inner = or();
      if (take() !== ")") throw new Error("missing )");
      return inner;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "cancelled()") return context.cancelled;
    if (token === "always()") return true;
    const needs = /^needs\.([\w-]+)\.(result|outputs\.(\w+))$/.exec(token);
    if (needs) {
      const [, name, field, output] = needs as unknown as [
        string,
        string,
        string,
        string | undefined,
      ];
      if (field === "result") {
        const result = context.results[name];
        if (result === undefined)
          throw new Error(`${token}: not a job it needs`);
        return result;
      }
      return context.outputs[name]?.[output as string] ?? "";
    }
    const github = /^github\.(\w+)$/.exec(token);
    if (github && GITHUB[github[1] as string] !== undefined)
      return GITHUB[github[1] as string] as string;
    throw new Error(`not modelled: ${token}`);
  };
  const equality = (): Value => {
    let left = primary();
    while (peek() === "==" || peek() === "!=") {
      const operator = take();
      const right = primary();
      left = operator === "==" ? same(left, right) : !same(left, right);
    }
    return left;
  };
  const and = (): Value => {
    let left = equality();
    while (peek() === "&&") {
      take();
      const right = equality();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): Value => {
    let left = and();
    while (peek() === "||") {
      take();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };

  const value = or();
  if (position !== tokens.length) throw new Error(`unexpected ${peek()}`);
  return value;
}

function ancestorsOf(workflow: Workflow, name: string): string[] {
  const seen = new Set<string>();
  const visit = (current: string) => {
    for (const need of needsOf(workflow.jobs[current] as Job))
      if (!seen.has(need)) {
        seen.add(need);
        visit(need);
      }
  };
  visit(name);
  return [...seen];
}

/** Every job that depends on `name`, directly or through other jobs. */
export function dependentsOf(workflow: Workflow, name: string): string[] {
  return Object.keys(workflow.jobs).filter((other) =>
    ancestorsOf(workflow, other).includes(name),
  );
}

/** Whether the `if` of a job names a status function, which switches off the implicit `success()`. */
export function hasStatusFunction(job: Job): boolean {
  if (job.if === undefined) return false;
  return tokenize(strip(String(job.if))).some((token) =>
    STATUS_FUNCTIONS.includes(token),
  );
}

/** What happens to each job of the workflow in one run, in the order the jobs depend on each other. */
export function simulate(
  workflow: Workflow,
  scenario: Scenario = {},
): Record<string, JobResult> {
  const results: Record<string, JobResult> = {};
  let runCancelled = scenario.cancelled ?? false;
  const pending = Object.keys(workflow.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((name) =>
      needsOf(workflow.jobs[name] as Job).every((need) => need in results),
    );
    if (index < 0) throw new Error("the jobs depend on each other in a circle");
    const name = pending.splice(index, 1)[0] as string;
    const job = workflow.jobs[name] as Job;
    const needs = needsOf(job);
    const context: Context = {
      results: Object.fromEntries(
        needs.map((need) => [need, results[need] as JobResult]),
      ),
      outputs: scenario.outputs ?? {},
      cancelled: runCancelled,
    };
    const implicitSuccess = !hasStatusFunction(job);
    const upstreamSucceeded = ancestorsOf(workflow, name).every(
      (ancestor) => results[ancestor] === "success",
    );
    const condition =
      job.if === undefined
        ? true
        : truthy(evaluate(tokenize(strip(String(job.if))), context));
    const runs = (!implicitSuccess || upstreamSucceeded) && condition;
    if (!runs) results[name] = "skipped";
    else if (scenario.cancelling?.includes(name)) {
      results[name] = "cancelled";
      runCancelled = true;
    } else
      results[name] = scenario.failing?.includes(name) ? "failure" : "success";
  }
  return results;
}
