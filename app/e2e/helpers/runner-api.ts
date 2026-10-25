// SPDX-License-Identifier: LicenseRef-Proprietary

// A Dynamic runner played by the journey's script (#435): it claims a Dynamic job over the runner API with the runner
// token, as the privileged runner with the real OpenCode does, and reports a result. The browser lane has no engine
// to run (it needs root and the network rules of the privileged lane), but the app's side of a Dynamic run is the
// claim: which model, which key, which catalog entry. That is what the script reads and the journey asserts; the engine
// itself is proven in the Dynamic lane (e2e/dynamic/). The real runner of the journey advertises PR-Agent only, so it
// never takes a Dynamic job, and the script never takes a Diff job.
import { request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

const API = "/api/runners/v1";

/** What the script reads from a claimed Dynamic job: the parts the app's selection decides. */
export type ClaimedDynamicJob = {
  id: string;
  leaseToken: string;
  /** The `llm` object of the job input: provider, model and the key the model is asked with. */
  llm: { provider: string; model: string; apiKey: string };
  /**
   * The `dynamic` object of the job input: the model of the agent and, for a native job (#578), the cost policy and the entry of
   * the model, whose `upstreamBaseUrl` is where the supervisor sends the key.
   */
  dynamic: {
    model: string;
    cost?: { keyMode: string };
    modelEntry?: {
      providerId: string;
      modelId: string;
      upstreamBaseUrl: string;
    };
  };
};

export type DynamicRunnerScript = {
  /**
   * Claims the next Dynamic job, or null when none is due. `features` are what the runner says it can do besides the default; a
   * native job (#578) goes only to a runner that names `dynamic_cost_policy`.
   */
  claim(features?: readonly string[]): Promise<ClaimedDynamicJob | null>;
  /** Reports a finished run: the model the engine reports in its usage and the cost the provider stated. */
  complete(job: ClaimedDynamicJob, usage: { model: string }): Promise<void>;
  dispose(): Promise<void>;
};

export async function dynamicRunnerScript(
  appUrl: string,
): Promise<DynamicRunnerScript> {
  const context: APIRequestContext = await request.newContext({
    baseURL: appUrl,
    extraHTTPHeaders: {
      authorization: `Bearer ${e2eEnv.runnerToken}`,
      "x-runner-id": "e2e-dynamic-script",
    },
  });
  return {
    async claim(features = ["dynamic_capabilities"]) {
      const response = await context.post(`${API}/claim`, {
        data: {
          engines: ["opencode"],
          features,
          llmProviders: ["openrouter"],
        },
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
          input: {
            llm: { provider: string; model: string; apiKey: string };
            dynamic: ClaimedDynamicJob["dynamic"];
          };
        };
      };
      return {
        id: body.job.id,
        leaseToken: body.job.leaseToken,
        llm: body.job.input.llm,
        dynamic: body.job.input.dynamic,
      };
    },
    async complete(job, usage) {
      const response = await context.post(`${API}/jobs/${job.id}/complete`, {
        data: {
          leaseToken: job.leaseToken,
          result: {
            ok: true,
            durationMs: 1000,
            commentUrl: null,
            errorCode: null,
            logTail: "",
            usage: {
              model: usage.model,
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
              aiCalls: 1,
              fallbackUsed: false,
              costUsd: 0.0001,
            },
          },
        },
      });
      if (response.status() !== 200)
        throw new Error(
          `The completion answered ${String(response.status())}: ${await response.text()}`,
        );
    },
    async dispose() {
      await context.dispose();
    },
  };
}
