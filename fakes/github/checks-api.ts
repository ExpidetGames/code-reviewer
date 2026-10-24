// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the fake GitHub that serves the Checks API and the pull request review API as a GitHub App uses
// them (#405): creating and updating a check run, listing the check runs of a commit, submitting a review and
// listing the reviews of a pull request. It sits inside the GitHub App part (`app-api.ts`), which authenticates the
// installation token, finds the repository and hands the rest of the path over; the answers are shaped like
// GitHub's.
//
// What it checks, like GitHub: a check run needs `checks: write` (403 `Resource not accessible by integration`
// otherwise), a name and a 40 character head sha; `status` is one of `queued`, `in_progress`, `completed`, a
// completed check run has a `conclusion` from GitHub's list (and a conclusion alone completes it, 422 for an unknown
// one); the list of a commit's check runs is paged and, as on GitHub, shows only the latest run of a name unless `filter=all`. A review needs `pull_requests: write`, an event of `APPROVE`, `REQUEST_CHANGES` or `COMMENT`, and an App
// cannot approve or request changes on a pull request it wrote itself (422), and its `commit_id` must be a commit the pull request has had (422). Every state change of a check run is
// kept in its `history`, so a test can assert the transitions and not only the last state. Dummy data only.

export const CHECK_RUN_STATUSES = [
  "queued",
  "in_progress",
  "completed",
] as const;
export const CHECK_RUN_CONCLUSIONS = [
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
] as const;

export type FakeCheckRunState = {
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
};

export type FakeCheckRun = {
  id: number;
  /** "owner/name". */
  repository: string;
  name: string;
  headSha: string;
  externalId: string | null;
  detailsUrl: string | null;
  status: string;
  conclusion: string | null;
  output: { title: string; summary: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The login of the app that wrote it (`<slug>[bot]`). */
  login: string;
  /** Every state it was in, oldest first: the one it was created with, then one per update. */
  history: FakeCheckRunState[];
};

export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
const STATE_OF_EVENT: Record<string, string> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

export type FakePullRequestReview = {
  id: number;
  repository: string;
  pullRequestNumber: number;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`. */
  state: string;
  body: string;
  login: string;
  commitId: string | null;
  submittedAt: string;
  /** The message it was dismissed with; null while it stands. */
  dismissalMessage: string | null;
};

export type ChecksApiAnswer = { status: number; body: unknown } | undefined;

export type ChecksApiRequest = {
  method: string;
  rest: string;
  query: URLSearchParams;
  repository: { id: number; fullName: string };
  pullRequests: Array<{
    number: number;
    state: string;
    author: { login: string };
  }>;
  /** Every commit the pull request has had as its head: a review may name any of them. */
  commitsOf: (number: number) => ReadonlySet<string>;
  body: () => Promise<string>;
  mayDo: (names: string[], level: "read" | "write") => boolean;
};

export type ChecksApi = {
  handle(request: ChecksApiRequest): Promise<ChecksApiAnswer>;
  checkRuns(repository: string): FakeCheckRun[];
  reviews(repository: string, number: number): FakePullRequestReview[];
  addReview(
    repository: string,
    number: number,
    review: { login: string; event: string; body?: string; commitId?: string },
  ): FakePullRequestReview;
  /** The state each reviewer's latest review that is not a comment leaves (what GitHub calls the review decision). */
  reviewDecisions(
    repository: string,
    number: number,
  ): Record<string, "APPROVED" | "CHANGES_REQUESTED">;
  reset(): void;
};

export type ChecksApiOptions = {
  webBase: () => string;
  apiBase: () => string;
  botLogin: string;
  now: () => number;
};

const FORBIDDEN = {
  status: 403,
  body: { message: "Resource not accessible by integration" },
};
const NOT_FOUND = { status: 404, body: { message: "Not Found" } };

function invalid(message: string): { status: number; body: unknown } {
  return { status: 422, body: { message, errors: [] } };
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createChecksApi(options: ChecksApiOptions): ChecksApi {
  const runs = new Map<string, FakeCheckRun[]>();
  const reviews = new Map<string, FakePullRequestReview[]>();
  let nextRunId = 9000;
  let nextReviewId = 5000;

  function runJson(run: FakeCheckRun) {
    return {
      id: run.id,
      name: run.name,
      head_sha: run.headSha,
      external_id: run.externalId,
      status: run.status,
      conclusion: run.conclusion,
      details_url: run.detailsUrl,
      html_url: `${options.webBase()}/${run.repository}/runs/${run.id}`,
      url: `${options.apiBase()}/repos/${run.repository}/check-runs/${run.id}`,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      output: run.output
        ? { ...run.output, text: null, annotations_count: 0 }
        : { title: null, summary: null, text: null, annotations_count: 0 },
      app: { slug: run.login.replace(/\[bot\]$/, "") },
    };
  }

  function reviewJson(review: FakePullRequestReview) {
    return {
      id: review.id,
      user: { login: review.login },
      body: review.body,
      state: review.state,
      commit_id: review.commitId,
      submitted_at: review.submittedAt,
      html_url: `${options.webBase()}/${review.repository}/pull/${review.pullRequestNumber}#pullrequestreview-${review.id}`,
    };
  }

  /** The fields of a body that is a JSON object, or null. */
  function parseObject(text: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** Applies the fields of a create or update body; a problem is the 422 answer. */
  function applyFields(
    run: FakeCheckRun,
    fields: Record<string, unknown>,
  ): { status: number; body: unknown } | undefined {
    if ("status" in fields) {
      if (
        typeof fields.status !== "string" ||
        !CHECK_RUN_STATUSES.some((status) => status === fields.status)
      )
        return invalid("Invalid check run status");
      run.status = fields.status;
    }
    if ("conclusion" in fields) {
      if (
        typeof fields.conclusion !== "string" ||
        !CHECK_RUN_CONCLUSIONS.some(
          (conclusion) => conclusion === fields.conclusion,
        )
      )
        return invalid("Invalid check run conclusion");
      run.conclusion = fields.conclusion;
      // A conclusion completes the check run, as on GitHub.
      if (!("status" in fields)) run.status = "completed";
    }
    if (run.status === "completed" && run.conclusion === null)
      return invalid("A completed check run needs a conclusion");
    if (typeof fields.external_id === "string")
      run.externalId = fields.external_id;
    if (typeof fields.details_url === "string")
      run.detailsUrl = fields.details_url;
    if (typeof fields.started_at === "string")
      run.startedAt = fields.started_at;
    if (typeof fields.completed_at === "string")
      run.completedAt = fields.completed_at;
    else if (run.status === "completed" && run.completedAt === null)
      run.completedAt = isoSeconds(options.now());
    const output = fields.output;
    if (typeof output === "object" && output !== null) {
      const { title, summary } = output as {
        title?: unknown;
        summary?: unknown;
      };
      if (typeof title !== "string" || typeof summary !== "string")
        return invalid("Invalid check run output");
      run.output = { title, summary };
    }
    run.history.push({
      status: run.status,
      conclusion: run.conclusion,
      title: run.output?.title ?? null,
      summary: run.output?.summary ?? null,
    });
    return undefined;
  }

  async function handle(request: ChecksApiRequest): Promise<ChecksApiAnswer> {
    const { method, rest, repository } = request;
    const fullName = repository.fullName;
    const list = runs.get(fullName) ?? [];

    if (rest === "/check-runs" && method === "POST") {
      if (!request.mayDo(["checks"], "write")) return FORBIDDEN;
      const fields = parseObject(await request.body());
      if (fields === null) return invalid("Invalid request body");
      if (typeof fields.name !== "string" || fields.name === "")
        return invalid("name is required");
      if (
        typeof fields.head_sha !== "string" ||
        !/^[0-9a-f]{40}$/.test(fields.head_sha)
      )
        return invalid("head_sha must be a full commit sha");
      const run: FakeCheckRun = {
        id: nextRunId++,
        repository: fullName,
        name: fields.name,
        headSha: fields.head_sha,
        externalId: null,
        detailsUrl: null,
        status: "queued",
        conclusion: null,
        output: null,
        startedAt: null,
        completedAt: null,
        login: options.botLogin,
        history: [],
      };
      const problem = applyFields(run, fields);
      if (problem !== undefined) return problem;
      runs.set(fullName, [...list, run]);
      return { status: 201, body: runJson(run) };
    }

    const runMatch = /^\/check-runs\/(\d+)$/.exec(rest);
    if (runMatch && (method === "PATCH" || method === "GET")) {
      if (!request.mayDo(["checks"], method === "GET" ? "read" : "write"))
        return FORBIDDEN;
      const run = list.find((item) => item.id === Number(runMatch[1]));
      if (run === undefined) return NOT_FOUND;
      if (method === "GET") return { status: 200, body: runJson(run) };
      const fields = parseObject(await request.body());
      if (fields === null) return invalid("Invalid request body");
      const problem = applyFields(run, fields);
      if (problem !== undefined) return problem;
      return { status: 200, body: runJson(run) };
    }

    const commitMatch = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(rest);
    if (commitMatch && method === "GET") {
      if (!request.mayDo(["checks"], "read")) return FORBIDDEN;
      const name = request.query.get("check_name");
      let matching = list.filter(
        (run) =>
          run.headSha === commitMatch[1] &&
          (name === null || run.name === name),
      );
      // Like GitHub, `filter=latest` is the default: of the runs with one name by one app only the latest is listed.
      if ((request.query.get("filter") ?? "latest") === "latest") {
        const latest = new Map<string, FakeCheckRun>();
        for (const run of matching) latest.set(`${run.login}/${run.name}`, run);
        matching = [...latest.values()];
      }
      const perPage = Math.min(
        Math.max(Number(request.query.get("per_page")) || 30, 1),
        100,
      );
      const page = Math.max(Number(request.query.get("page")) || 1, 1);
      return {
        status: 200,
        body: {
          total_count: matching.length,
          check_runs: matching
            .slice((page - 1) * perPage, page * perPage)
            .map(runJson),
        },
      };
    }

    // Dismissing a review needs the pull request permission; only a review that counts (an approval or a request for
    // changes that stands) can be dismissed, and a message is required, as on GitHub.
    const dismissMatch = /^\/pulls\/(\d+)\/reviews\/(\d+)\/dismissals$/.exec(
      rest,
    );
    if (dismissMatch && method === "PUT") {
      if (!request.mayDo(["pull_requests"], "write")) return FORBIDDEN;
      const key = `${fullName}#${Number(dismissMatch[1])}`;
      const review = (reviews.get(key) ?? []).find(
        (item) => item.id === Number(dismissMatch[2]),
      );
      if (review === undefined) return NOT_FOUND;
      const fields = parseObject(await request.body());
      if (fields === null || typeof fields.message !== "string")
        return invalid("message is required");
      if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED")
        return invalid("Can not dismiss a review that does not stand");
      review.state = "DISMISSED";
      review.dismissalMessage = fields.message;
      return { status: 200, body: reviewJson(review) };
    }

    const reviewsMatch = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (reviewsMatch) {
      const number = Number(reviewsMatch[1]);
      const pull = request.pullRequests.find((item) => item.number === number);
      if (method === "GET") {
        if (!request.mayDo(["pull_requests"], "read")) return FORBIDDEN;
        if (pull === undefined) return NOT_FOUND;
        const all = reviews.get(`${fullName}#${number}`) ?? [];
        const perPage = Math.min(
          Math.max(Number(request.query.get("per_page")) || 30, 1),
          100,
        );
        const page = Math.max(Number(request.query.get("page")) || 1, 1);
        return {
          status: 200,
          body: all.slice((page - 1) * perPage, page * perPage).map(reviewJson),
        };
      }
      if (method === "POST") {
        if (!request.mayDo(["pull_requests"], "write")) return FORBIDDEN;
        if (pull === undefined) return NOT_FOUND;
        const fields = parseObject(await request.body());
        if (fields === null) return invalid("Invalid request body");
        const event = fields.event;
        if (
          typeof event !== "string" ||
          !REVIEW_EVENTS.some((known) => known === event)
        )
          return invalid("Unprocessable request: event is not valid");
        if (event !== "COMMENT" && pull.author.login === options.botLogin)
          return invalid("Can not approve your own pull request");
        if (
          typeof fields.commit_id === "string" &&
          !request.commitsOf(number).has(fields.commit_id)
        )
          return invalid("commit_id is not part of the pull request");
        if (event !== "APPROVE" && typeof fields.body !== "string")
          return invalid("Body is required for this event");
        const review = addReview(fullName, number, {
          login: options.botLogin,
          event,
          body: typeof fields.body === "string" ? fields.body : "",
          ...(typeof fields.commit_id === "string"
            ? { commitId: fields.commit_id }
            : {}),
        });
        return { status: 200, body: reviewJson(review) };
      }
    }
    return undefined;
  }

  function addReview(
    repository: string,
    number: number,
    review: { login: string; event: string; body?: string; commitId?: string },
  ): FakePullRequestReview {
    const stored: FakePullRequestReview = {
      id: nextReviewId++,
      repository,
      pullRequestNumber: number,
      state: STATE_OF_EVENT[review.event] ?? "COMMENTED",
      body: review.body ?? "",
      login: review.login,
      commitId: review.commitId ?? null,
      submittedAt: isoSeconds(options.now()),
      dismissalMessage: null,
    };
    const key = `${repository}#${number}`;
    reviews.set(key, [...(reviews.get(key) ?? []), stored]);
    return stored;
  }

  return {
    handle,
    checkRuns: (repository) => [...(runs.get(repository) ?? [])],
    reviews: (repository, number) => [
      ...(reviews.get(`${repository}#${number}`) ?? []),
    ],
    addReview,
    reviewDecisions(repository, number) {
      const decisions: Record<string, "APPROVED" | "CHANGES_REQUESTED"> = {};
      for (const review of reviews.get(`${repository}#${number}`) ?? []) {
        if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
          decisions[review.login] = review.state;
      }
      return decisions;
    },
    reset() {
      runs.clear();
      reviews.clear();
      nextRunId = 9000;
      nextReviewId = 5000;
    },
  };
}
