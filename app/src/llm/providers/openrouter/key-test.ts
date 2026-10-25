// SPDX-License-Identifier: LicenseRef-Proprietary

// The "test key" call to OpenRouter (docs/decisions/0001-editions-setup-and-accounts.md, issue #104): one cheap
// call that says whether the key is accepted, and the class of the failure when it is not (`llm_key_rejected`,
// `llm_unreachable`, `llm_provider_error`) with a sentence that is safe to show.
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
//
// The limits per workspace and for the instance are the same for every provider (src/llm/key-test.ts).
import { sanitizeServerMessage } from "../../../mail/smtp-failure.ts";
import { readProviderMessage } from "../provider-message.ts";
import { KEY_TEST_TIMEOUT_MS, type LlmProviderOperations } from "../types.ts";

/** The path that tells a key's state without costing anything (no tokens are used). */
const KEY_INFO_PATH = "/key";

/**
 * Asks OpenRouter whether `apiKey` is accepted. Never throws; never puts the key (or anything the provider
 * echoed of it) into the result. `baseUrl` is the provider's API address (src/llm/endpoint.ts), never a value
 * from a request.
 */
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
  const detail = sanitizeServerMessage(await readProviderMessage(response), [
    apiKey,
  ]);
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "llm_key_rejected", detail };
  if (response.status >= 500 && response.status !== 501)
    return { ok: false, error: "llm_unreachable", detail };
  return { ok: false, error: "llm_provider_error", detail };
};
