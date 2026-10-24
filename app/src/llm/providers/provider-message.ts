// SPDX-License-Identifier: LicenseRef-Proprietary

// What every adapter's key test does with an error answer of its provider: read a few kilobytes at most and
// take the provider's own sentence out of it. Nothing here passes the sentence on; the caller cleans it
// (`sanitizeServerMessage`) before it is shown.

const MAX_ANSWER_BYTES = 8 * 1024;

/** The first `error.message` of a JSON answer, or the first line of the text; null if there is nothing. */
export async function readProviderMessage(
  response: Response,
): Promise<string | null> {
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
