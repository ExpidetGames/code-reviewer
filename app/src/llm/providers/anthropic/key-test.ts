// SPDX-License-Identifier: Apache-2.0

// The "test key" call to the Claude API: `GET /v1/models` lists the models the key can use and costs nothing (no
// tokens). The rules are the ones of every adapter (src/llm/key-test.ts has the limits):
//
// - the address is the provider's own (src/llm/endpoint.ts), nothing a person types; the request does not follow
//   redirects (a redirect would carry the key to another host), has a short time limit and reads a few
//   kilobytes of the answer at most;
// - nothing the provider says is passed on as it is: the detail is the first line of its message with the key
//   removed in every spelling, as printable text and cut short.
//
// The key travels in the `x-api-key` header, with the API version Anthropic requires on every request.
import { sanitizeServerMessage } from "../../../mail/smtp-failure.ts";
import { readProviderMessage } from "../provider-message.ts";
import { KEY_TEST_TIMEOUT_MS, type LlmProviderOperations } from "../types.ts";

/** The path that tells a key's state without costing anything. One model is enough to prove it. */
const KEY_INFO_PATH = "/models?limit=1";
export const ANTHROPIC_VERSION = "2023-06-01";

export const testKey: LlmProviderOperations["testKey"] = async ({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = KEY_TEST_TIMEOUT_MS,
}) => {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${KEY_INFO_PATH}`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
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
  const detail = sanitizeServerMessage(await readProviderMessage(response), [
    apiKey,
  ]);
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "llm_key_rejected", detail };
  // 529 is Anthropic's "overloaded": the service did not answer the call, like any 5xx.
  if (response.status >= 500 && response.status !== 501)
    return { ok: false, error: "llm_unreachable", detail };
  return { ok: false, error: "llm_provider_error", detail };
};
