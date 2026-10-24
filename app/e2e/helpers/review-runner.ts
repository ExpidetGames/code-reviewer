// SPDX-License-Identifier: LicenseRef-Proprietary

// A runner played by the journey's script (the billing journeys, #508): it asks the app for the next job over the runner API with the runner
// token, as the real runner does, and reports the result it chooses. The money of a review is decided by the app's claim (the balance) and
// by the app's settlement (the price of what the result says), so the script only has to hand out and report; the engine itself is proven in
// its own lanes (e2e/jobs, e2e/dynamic). A claim that is refused for the balance or a limit answers "no job" (204) and leaves the notice on the
// pull request, exactly as it does for the real runner.
import { request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

const API = "/api/runners/v1";

export type ReviewKind = "diff" | "dynamic";

/** What the script reads from a handed-out job. */
export type HandedOutJob = {
  id: string;
  leaseToken: string;
  /** The `llm` object of the job input: provider, model and the key the model is asked with. */
  llm: { provider: string; model: string; apiKey: string };
};

export type ReviewRunnerScript = {
  /** Asks for the next job of a kind once; null when none was handed out (none queued, or the claim refused it). */
  claimOnce(kind: ReviewKind): Promise<HandedOutJob | null>;
  /** Reports a run that finished with a review and the model cost the provider stated. */
  succeed(job: HandedOutJob, costUsd: number | null): Promise<void>;
  /** Reports a run that ended with a stable error code and the cost it incurred before. */
  fail(
    job: HandedOutJob,
    errorCode: string,
    costUsd: number | null,
  ): Promise<void>;
  dispose(): Promise<void>;
};

function resultOf(job: HandedOutJob, costUsd: number | null, ok: boolean) {
  return {
    ok,
    durationMs: 1000,
    commentUrl: null,
    errorCode: null,
    logTail: "",
    usage: {
      model: job.llm.model,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      aiCalls: 1,
      fallbackUsed: false,
      costUsd,
    },
  };
}

export async function reviewRunnerScript(
  appUrl: string,
): Promise<ReviewRunnerScript> {
  const context: APIRequestContext = await request.newContext({
    baseURL: appUrl,
    extraHTTPHeaders: {
      authorization: `Bearer ${e2eEnv.runnerToken}`,
      "x-runner-id": "e2e-billing-script",
    },
  });
  async function report(
    job: HandedOutJob,
    result: Record<string, unknown>,
  ): Promise<void> {
    const response = await context.post(`${API}/jobs/${job.id}/complete`, {
      data: { leaseToken: job.leaseToken, result },
    });
    if (response.status() !== 200)
      throw new Error(
        `The completion answered ${String(response.status())}: ${await response.text()}`,
      );
  }
  return {
    async claimOnce(kind) {
      const response = await context.post(`${API}/claim`, {
        data:
          kind === "dynamic"
            ? {
                engines: ["opencode"],
                features: ["dynamic_capabilities"],
                llmProviders: ["openrouter"],
              }
            : { llmProviders: ["openrouter"] },
      });
      if (response.status() === 204) return null;
      if (response.status() !== 200)
        throw new Error(
          `The claim answered ${String(response.status())}: ${await response.text()}`,
        );
      const body = (await response.json()) as {
        job: {
          id: string;
          leaseToken: string;
          input: { llm: HandedOutJob["llm"] };
        };
      };
      return {
        id: body.job.id,
        leaseToken: body.job.leaseToken,
        llm: body.job.input.llm,
      };
    },
    async succeed(job, costUsd) {
      await report(job, resultOf(job, costUsd, true));
    },
    async fail(job, errorCode, costUsd) {
      await report(job, {
        ...resultOf(job, costUsd, false),
        errorCode,
        errorMessage: null,
      });
    },
    async dispose() {
      await context.dispose();
    },
  };
}
