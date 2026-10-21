// SPDX-License-Identifier: Apache-2.0

// Scripted bad days of the fake Stripe API. A rule says which requests it hits (method and path), what happens and how
// many times; the first rule with tries left that matches a request is used up by it. Stripe has idempotency keys, so
// the case that matters most is the one where a POST ran and the caller never heard: `dropResponse` and `delay` let the
// request run (and its result be saved under its key), the others stop it before it does anything.

export type FaultMatch = {
  /** Any method when left out. */
  method?: string;
  /** An exact path (`/v1/customers`) or a pattern; any path when left out. The query string is not part of it. */
  path?: string | RegExp;
};

export type RawAnswer = {
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type FaultAction =
  /** The request runs, the answer is lost: `hang` never answers, `reset` closes the connection. */
  | { kind: "drop"; mode: "hang" | "reset" }
  /** The request does not run; this status (with Stripe's error body unless one is given) is the answer. */
  | { kind: "status"; status: number; body?: unknown }
  /** The request does not run; 429 with `Retry-After`. */
  | { kind: "rate_limit"; retryAfterSeconds: number }
  /** The request runs, the answer comes after this many milliseconds. */
  | { kind: "delay"; ms: number }
  /** The request does not run; this raw answer is sent as it is (an oversize body, a redirect, text that is no JSON). */
  | { kind: "raw"; answer: RawAnswer };

type Rule = { match: FaultMatch; action: FaultAction; remaining: number };

function matches(match: FaultMatch, method: string, path: string): boolean {
  if (match.method !== undefined && match.method.toUpperCase() !== method)
    return false;
  if (match.path === undefined) return true;
  return typeof match.path === "string"
    ? match.path === path
    : match.path.test(path);
}

export function createFaults() {
  let rules: Rule[] = [];
  const add = (
    match: FaultMatch,
    action: FaultAction,
    times: number | undefined,
  ) => {
    rules.push({ match, action, remaining: times ?? 1 });
  };
  return {
    /** For the server: the action for this request, if a rule hits it. */
    take(method: string, path: string): FaultAction | undefined {
      const rule = rules.find(
        (candidate) =>
          candidate.remaining > 0 && matches(candidate.match, method, path),
      );
      if (rule === undefined) return undefined;
      rule.remaining -= 1;
      return rule.action;
    },
    /** The request runs, then the answer is lost. */
    dropResponse(
      match: FaultMatch,
      options: { times?: number; mode?: "hang" | "reset" } = {},
    ): void {
      add(match, { kind: "drop", mode: options.mode ?? "hang" }, options.times);
    },
    failWith(
      match: FaultMatch,
      status: number,
      options: { times?: number; body?: unknown } = {},
    ): void {
      add(
        match,
        {
          kind: "status",
          status,
          ...(options.body === undefined ? {} : { body: options.body }),
        },
        options.times,
      );
    },
    rateLimit(
      match: FaultMatch,
      options: { retryAfterSeconds: number; times?: number },
    ): void {
      add(
        match,
        { kind: "rate_limit", retryAfterSeconds: options.retryAfterSeconds },
        options.times,
      );
    },
    delay(
      match: FaultMatch,
      ms: number,
      options: { times?: number } = {},
    ): void {
      add(match, { kind: "delay", ms }, options.times);
    },
    respondWith(
      match: FaultMatch,
      answer: RawAnswer,
      options: { times?: number } = {},
    ): void {
      add(match, { kind: "raw", answer }, options.times);
    },
    clear(): void {
      rules = [];
    },
  };
}

export type Faults = ReturnType<typeof createFaults>;
