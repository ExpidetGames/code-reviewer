// SPDX-License-Identifier: LicenseRef-Proprietary

// The "Test" button of the operator's keys in the admin portal (#427): one cheap call to the provider that says
// whether the key is accepted (`checkLlmKey`, the call the workspace's button makes through the provider's adapter).
// What is the same as the workspace's button is that call, its answers and its rate-limited shape; what is its own
// is the counters: an allowance for each admin and a budget for the instance, kept apart from the workspace
// button's (src/llm/key-test.ts), so neither can use up the other's. Counters that cannot be read refuse the click
// (the caller answers 503), they never wave it through. The key is absent from the log line.
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { LlmProvider } from "./config.ts";
import {
  checkLlmKey,
  KEY_TEST_WINDOW_MS,
  type LlmKeyTestResult,
} from "./key-test.ts";
import type { FetchLike } from "./providers/types.ts";

export const OPERATOR_KEY_TEST_ADMIN_MAX = 5;
export const OPERATOR_KEY_TEST_GLOBAL_MAX = 60;

export function operatorKeyTestAdminKey(adminId: string): string {
  return `operator-llm-key-test:admin:${adminId}`;
}
export const OPERATOR_KEY_TEST_GLOBAL_KEY = "operator-llm-key-test:all";

export type OperatorKeyTestService = {
  /** Tests the key (the caller has chosen which one: the typed one or the stored one). */
  test(input: {
    adminId: string;
    provider: LlmProvider;
    apiKey: string;
  }): Promise<LlmKeyTestResult>;
};

export function createOperatorKeyTestService({
  rateLimits,
  baseUrlOf,
  fetchImpl,
  timeoutMs,
  now = () => new Date(),
  log = console.error,
}: {
  rateLimits: RateLimitsRepository;
  /** The provider's API address; the real one, or the fake in the test stack (src/llm/endpoint.ts). */
  baseUrlOf: (provider: LlmProvider) => string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}): OperatorKeyTestService {
  return {
    async test({ adminId, provider, apiKey }) {
      const limited = (hit: { windowStartedAt: Date }) =>
        ({
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: secondsLeft(
            hit.windowStartedAt,
            KEY_TEST_WINDOW_MS,
            now(),
          ),
        }) as const;
      // The counter of the instance first: an admin over their own allowance must not use up the budget of the
      // instance (the attempt is taken back), and an instance out of budget counts against no admin.
      const instance = await rateLimits.hit(
        OPERATOR_KEY_TEST_GLOBAL_KEY,
        KEY_TEST_WINDOW_MS,
      );
      if (instance.count > OPERATOR_KEY_TEST_GLOBAL_MAX)
        return limited(instance);
      const own = await rateLimits.hit(
        operatorKeyTestAdminKey(adminId),
        KEY_TEST_WINDOW_MS,
      );
      if (own.count > OPERATOR_KEY_TEST_ADMIN_MAX) {
        await rateLimits.refund(OPERATOR_KEY_TEST_GLOBAL_KEY);
        return limited(own);
      }

      const result = await checkLlmKey({
        baseUrl: baseUrlOf(provider),
        apiKey,
        provider,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (!result.ok) log(`[llm] OPERATOR_KEY_TEST_FAILED: ${result.error}`);
      return result;
    },
  };
}
