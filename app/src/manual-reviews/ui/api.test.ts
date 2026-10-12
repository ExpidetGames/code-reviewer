// SPDX-License-Identifier: Apache-2.0

// Pins down the calls the panel makes: the addresses (with the repository id encoded), the methods and
// the JSON body, and that a refusal comes back as a code.
import { describe, expect, it, vi } from "vitest";
import { createManualReviewApi } from "./api.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the manual start API", () => {
  it("asks for the open pull requests of the repository", async () => {
    const fetchImpl = vi.fn(async () => json({ pullRequests: [] }));

    const result = await createManualReviewApi(
      fetchImpl,
      "acme",
    ).listPullRequests("a/b c");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/w/acme/repositories/a%2Fb%20c/pull-requests",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(result).toEqual({ ok: true, data: { pullRequests: [] } });
  });

  it("posts the start request as JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ runId: "r1", created: true }, 201),
    );

    await createManualReviewApi(fetchImpl, "acme").startReview("repo-1", {
      prNumber: 7,
      command: "ask",
      question: "Why?",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/w/acme/repositories/repo-1/reviews",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prNumber: 7, command: "ask", question: "Why?" }),
      }),
    );
  });

  it("returns the code of a refusal and the fields that were wrong", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          error: "MANUAL_REVIEW_REQUEST_INVALID",
          issues: [{ field: "prNumber", code: "invalid" }],
        },
        400,
      ),
    );

    const result = await createManualReviewApi(fetchImpl, "acme").startReview(
      "repo-1",
      {
        prNumber: 0,
        command: "review",
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: "MANUAL_REVIEW_REQUEST_INVALID",
      issues: [{ field: "prNumber", code: "invalid" }],
    });
  });
});
