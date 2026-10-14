// SPDX-License-Identifier: Apache-2.0

// The runner API as three functions of their collaborators (`createRunnerApi`). The route files
// only call `withRunnerApi` (shared.ts); tests build the API with fakes and a real database.
//
// The order is the contract; each step ends the request on failure, and nothing in a handler before
// the token check touches the database or GitHub (building the collaborators in shared.ts only
// opens nothing; if that fails, the route answers 500 in the same form):
//
//   1. token     `Authorization: Bearer <RUNNER_TOKEN>`, constant time compare       401
//   2. runner id `X-Runner-Id`, optional, for bookkeeping only                       400
//   3. job id    a UUID in the path (heartbeat, complete)                            400
//   4. body      read up to 64 KiB, JSON object, checked                             413 / 400
//   5. work      claim, heartbeat or complete                                        see contract
//
// Every answer carries `Cache-Control: no-store` (responses.ts).
import "server-only";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { DEFAULT_ENGINES } from "../jobs/runner-capabilities.ts";
import { RUNNER_MAX_BODY_BYTES } from "./contract.ts";
import { handleClaim, type ClaimDeps } from "./claim.ts";
import { describeError } from "./logger.ts";
import { parseClaimRequest, parseJobId, parseRunnerId } from "./requests.ts";
import { handleComplete, handleHeartbeat, type ReportDeps } from "./report.ts";
import { errorResponse, unauthorized } from "./responses.ts";
import { bearerTokenOf, tokensMatch } from "./token-auth.ts";

export type RunnerApiDeps = ClaimDeps &
  ReportDeps & {
    /** The configured shared secret (`RUNNER_TOKEN`), read for every request. */
    runnerToken: () => string | undefined;
  };

export type RunnerApi = {
  claim(request: Request): Promise<Response>;
  heartbeat(request: Request, jobId: string): Promise<Response>;
  complete(request: Request, jobId: string): Promise<Response>;
};

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request): Promise<Body> {
  const body = await readLimitedBody(request, RUNNER_MAX_BODY_BYTES);
  if (!body.ok)
    return { ok: false, response: errorResponse(413, "RUNNER_BODY_TOO_LARGE") };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "body", code: "invalid" }],
      }),
    };
  }
}

/**
 * The claim body is optional (#195): a previous-release runner sends none. An empty body is the same
 * as no body; anything else must be JSON, and a body over the limit is refused before it is parsed.
 */
async function readOptionalJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readLimitedBody(request, RUNNER_MAX_BODY_BYTES);
  if (!body.ok)
    return { ok: false, response: errorResponse(413, "RUNNER_BODY_TOO_LARGE") };
  if (body.text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "body", code: "invalid" }],
      }),
    };
  }
}

export function createRunnerApi(deps: RunnerApiDeps): RunnerApi {
  /** Steps 1 and 2: who is asking. */
  function identify(
    request: Request,
  ): { ok: true; runnerId: string } | { ok: false; response: Response } {
    const provided = bearerTokenOf(request.headers.get("authorization"));
    if (provided === null || !tokensMatch(deps.runnerToken(), provided))
      return { ok: false, response: unauthorized() };
    const runnerId = parseRunnerId(request.headers.get("x-runner-id"));
    if (!runnerId.ok)
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_ID_INVALID"),
      };
    return { ok: true, runnerId: runnerId.value };
  }

  /** A failure nobody planned for: the caller gets a generic answer, the log gets the cause. */
  function unexpected(what: string, error: unknown): Response {
    deps.logger.error(`[runner-api] ${what} failed: ${describeError(error)}`);
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }

  return {
    async claim(request) {
      try {
        const who = identify(request);
        if (!who.ok) return who.response;
        // The claim body is read after the token check and before any job is claimed (#195).
        const body = await readOptionalJsonBody(request);
        if (!body.ok) return body.response;
        const parsed = parseClaimRequest(body.value);
        if (!parsed.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: parsed.fields,
          });
        return await handleClaim(
          deps,
          who.runnerId,
          parsed.value.engines ?? DEFAULT_ENGINES,
          parsed.value.features ?? [],
        );
      } catch (error) {
        return unexpected("claim", error);
      }
    },

    async heartbeat(request, jobId) {
      try {
        const who = identify(request);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        return await handleHeartbeat(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("heartbeat", error);
      }
    },

    async complete(request, jobId) {
      try {
        const who = identify(request);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        return await handleComplete(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("complete", error);
      }
    },
  };
}
