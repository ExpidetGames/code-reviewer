// SPDX-License-Identifier: LicenseRef-Proprietary

// Copy helpers. The text comes from src/content (ours, never from a visitor), but it is escaped anyway.
// Use with `<Fragment set:html={inline(text)} />`.

/** Proper names that contain a hyphen; they must never break at it. */
const UNBREAKABLE = /(PR-Agent|(?:app\.)?code-review\.com|itegro-gmbh\.de)/;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CODE_CLASS = "rounded-md border border-line bg-raised px-1 font-mono text-sm text-fg";
export const LINK_CLASS =
  "rounded-sm underline decoration-line-strong underline-offset-4 transition-all duration-700 ease-fluid hover:text-fg hover:decoration-fg active:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg";

function keepTogether(text: string): string {
  return text
    .split(UNBREAKABLE)
    .map((part, index) => (index % 2 === 1 ? `<span class="whitespace-nowrap">${escapeHtml(part)}</span>` : escapeHtml(part)))
    .join("");
}

/**
 * Renders copy where `backticks` mark inline code (the mono font is for code only), keeps hyphenated proper
 * names on one line and keeps the last two words together (no orphans).
 */
export function inline(text: string): string {
  // Legal references never break after "§", "Art." or "Abs." (for example "§ 27a UStG").
  const glued = text.replace(/(§|Art\.|Abs\.) (\S+)/g, "$1 $2");
  const tidy = glued.trim().split(/\s+/).length > 2 ? glued.replace(/ (\S+)$/, " $1") : glued;
  return tidy
    .split("`")
    .map((part, index) => (index % 2 === 1 ? `<code class="${CODE_CLASS}">${escapeHtml(part)}</code>` : keepTogether(part)))
    .join("");
}

/** Copy of the legal texts: like `inline`, with the contact address turned into a mailto link. */
export function legalText(text: string, email: string): string {
  const parts = text.split(email);
  return parts
    .map((part, index) => {
      const last = index === parts.length - 1;
      // Text right before the address stays on its line ("E-Mail: info@…").
      const before = part ? inline(last ? part : part.replace(/ (\S+) $/, " $1 ")) : "";
      return last ? before : `${before}<a href="mailto:${email}" class="${LINK_CLASS} whitespace-nowrap">${email}</a>`;
    })
    .join("");
}
