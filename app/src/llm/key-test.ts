// SPDX-License-Identifier: Apache-2.0

// The "test key" button of the LLM access settings (docs/decisions/0001-editions-setup-and-accounts.md, issue
// #104): one cheap call to the provider that says whether the key is accepted, and the class of the failure when
// it is not (`llm_key_rejected`, `llm_unreachable`, `llm_provider_error`) with a sentence that is safe to show.
//
// - **The address is the provider's own** (src/llm/endpoint.ts): nothing a person types decides where the app
//   connects, so the button cannot be used to make the server call an address of somebody's choice. The request
//   does not follow redirects (a redirect would carry the key to another host), has a short time limit and reads
//   a few kilobytes of the answer at most.
// - **Nothing the provider says is passed on as it is.** A provider may repeat the key in its error text
//   ("Incorrect API key provided: sk-..."), and a hostile endpoint can write anything. The detail is the first
//   line of the provider's message with the key removed in every spelling (plain, base64, hex, percent
//   encoded, the same cleaning as the SMTP test mail, src/mail/smtp-failure.ts), long opaque tokens blanked,
//   as printable text and cut short. The key is also absent from the log line.
// - **Limited** per workspace and for the whole instance, counted in the shared `rate_limits` table; counters
//   that cannot be read refuse the click (the caller answers 503), they never wave it through.
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import { sanitizeServerMessage } from "../mail/smtp-failure.ts";
import type { LlmProvider } from "./config.ts";

export const LLM_KEY_TEST_FAILURE_CODES = [
  /** The provider refused the key (401, 403). */
  "llm_key_rejected",
  /** Nothing answered: the address does not resolve, the connection failed, or the time ran out. */
  "llm_unreachable",
  /** Any other answer than success: a rate limit or an error of the provider's, a redirect. */
  "llm_provider_error",
] as const;
export type LlmKeyTestFailureCode = (typeof LLM_KEY_TEST_FAILURE_CODES)[number];

export type LlmKeyCheck =
  | { ok: true }
  | { ok: false; error: LlmKeyTestFailureCode; detail: string | null };

export const KEY_TEST_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 8 * 1024;

/** The path that tells a key's state without costing anything (no tokens are used). */
const KEY_INFO_PATH = "/key";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The first `error.message` of a JSON answer, or the first line of the text; null if there is nothing. */
async function providerMessage(response: Response): Promise<string | null> {
  let text = "";
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ANSWER_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => undefined);
    text = Buffer.concat(chunks).subarray(0, MAX_ANSWER_BYTES).toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "object" && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message;
      }
      if (typeof error === "string") return error;
    }
  } catch {
    // not JSON: use the text
  }
  return text;
}

/**
 * Asks the provider whether `apiKey` is accepted. Never throws; never puts the key (or anything the provider
 * echoed of it) into the result.
 */
export async function checkLlmKey({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = KEY_TEST_TIMEOUT_MS,
}: {
  /** The provider's API address (src/llm/endpoint.ts), never a value from a request. */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LlmKeyCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${KEY_INFO_PATH}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      // A redirect would send the key on to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The error text of a failed fetch can name the address; the class is all the person needs.
    return { ok: false, error: "llm_unreachable", detail: null };
  }

  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: true };
  }
  const detail = sanitizeServerMessage(await providerMessage(response), [
    apiKey,
  ]);
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "llm_key_rejected", detail };
  if (response.status >= 500 && response.status !== 501)
    return { ok: false, error: "llm_unreachable", detail };
  return { ok: false, error: "llm_provider_error", detail };
}

export const KEY_TEST_WORKSPACE_MAX = 5;
export const KEY_TEST_GLOBAL_MAX = 60;
export const KEY_TEST_WINDOW_MS = 10 * 60 * 1000;

export function keyTestWorkspaceKey(workspaceId: string): string {
  return `llm-key-test:workspace:${workspaceId}`;
}
export const KEY_TEST_GLOBAL_KEY = "llm-key-test:all";

export type LlmKeyTestResult =
  LlmKeyCheck | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type LlmKeyTestService = {
  /** Tests the key (the caller has chosen which one: the typed one or the stored one). */
  test(input: {
    workspaceId: string;
    provider: LlmProvider;
    apiKey: string;
  }): Promise<LlmKeyTestResult>;
};

export function createLlmKeyTestService({
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
}): LlmKeyTestService {
  return {
    async test({ workspaceId, provider, apiKey }) {
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
      // The counter of the instance first: a workspace over its own allowance must not use up the budget of the
      // instance (its attempt is taken back), and an instance out of budget counts against no workspace.
      const instance = await rateLimits.hit(
        KEY_TEST_GLOBAL_KEY,
        KEY_TEST_WINDOW_MS,
      );
      if (instance.count > KEY_TEST_GLOBAL_MAX) return limited(instance);
      const own = await rateLimits.hit(
        keyTestWorkspaceKey(workspaceId),
        KEY_TEST_WINDOW_MS,
      );
      if (own.count > KEY_TEST_WORKSPACE_MAX) {
        await rateLimits.refund(KEY_TEST_GLOBAL_KEY);
        return limited(own);
      }

      const result = await checkLlmKey({
        baseUrl: baseUrlOf(provider),
        apiKey,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (!result.ok) log(`[llm] KEY_TEST_FAILED: ${result.error}`);
      return result;
    },
  };
}
