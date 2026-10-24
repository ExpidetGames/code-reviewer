// SPDX-License-Identifier: LicenseRef-Proprietary

// The provider string a tenant wrote in its own settings, made safe to log, to keep in a job's error detail and to show
// (#432, binding comment of #459). In own mode the resolver's `llm_provider_unsupported` echoes the raw value, which is
// unbounded and may carry line breaks or escape sequences. This is the one place that turns it into plain text: cut to a
// fixed length with the cut marked, every character outside a printable set replaced. It is data: it never reaches a
// command, a prompt or a header.

/** The longest text this returns, the marker of a cut included. */
export const MAX_PROVIDER_TEXT_CHARS = 64;
const CUT_MARKER = "...";
const REPLACEMENT = "?";

export function boundProviderText(raw: string): string {
  // Look at one character more than the bound allows, so a cut is known without reading the rest of a huge value.
  const head = Array.from(raw.slice(0, MAX_PROVIDER_TEXT_CHARS + 1));
  const cut = raw.length > MAX_PROVIDER_TEXT_CHARS;
  const safe = head
    .slice(0, MAX_PROVIDER_TEXT_CHARS)
    .map((character) =>
      /^[\x20-\x7e]$/.test(character) ? character : REPLACEMENT,
    )
    .join("");
  if (!cut) return safe;
  return `${safe.slice(0, MAX_PROVIDER_TEXT_CHARS - CUT_MARKER.length)}${CUT_MARKER}`;
}
