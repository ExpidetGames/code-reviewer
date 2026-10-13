// SPDX-License-Identifier: Apache-2.0

// The removed class names of the legacy stylesheet (#165, cleanup #185). This module finds one of
// them in a class context of a source file: a `className=`/`class=` attribute, the first string of a
// `cn`/`clsx`/`cva` call, or a CSS class selector. It deliberately ignores the same word in prose or
// a comment, so the guard reports a real use and never an English sentence.
//
// The names are the classes that `app/src/app/globals.css` defined before it was deleted. A screen
// that used one has moved onto the component kit; a new use is a regression.

export const REMOVED_CLASS_NAMES = [
  "muted",
  "user-menu-name",
  "btn",
  "btn-primary",
  "btn-secondary",
  "btn-ghost",
  "btn-destructive",
  "btn-block",
  "card",
  "alert",
  "alert-error",
  "page-header",
  "page-header-text",
  "page-header-actions",
  "empty-state",
  "page-loading",
  "auth-page",
  "auth-card",
  "login-form",
  "setup-card",
  "setup-form",
  "setup-code-input",
  "setup-options",
  "setup-option",
  "app-shell",
  "skip-link",
  "app-header",
  "app-header-inner",
  "brand",
  "header-end",
  "menu-button",
  "menu-icon",
  "main-nav",
  "nav-list",
  "nav-link",
  "app-main",
  "user-menu",
  "user-menu-button",
  "user-menu-panel",
  "user-menu-person",
  "user-menu-section",
  "user-menu-label",
  "avatar",
  "workspace-switcher",
  "workspace-switcher-button",
  "workspace-switcher-name",
  "workspace-switcher-panel",
  "workspace-list",
  "member-list",
  "member-row",
  "member-main",
  "member-name",
  "member-actions",
  "member-role",
  "pending-row",
  "small",
  "mono",
  "notices",
  "alert-warning",
  "alert-success",
  "badge",
  "badge-active",
  "badge-unavailable",
  "field-error",
  "steps",
  "project-list",
  "project-row",
  "project-main",
  "project-status",
  "project-name",
  "project-toggle",
  "switch",
  "switch-thumb",
  "sync",
  "sync-result",
  "settings-section",
  "status-list",
  "settings-form",
  "field",
  "field-head",
  "field-label",
  "check",
  "check-line",
  "check-row",
  "link-button",
  "cost-summary",
  "confirm",
  "form-actions",
  "badge-run",
  "badge-run-queued",
  "badge-run-running",
  "badge-run-succeeded",
  "badge-run-failed",
  "badge-run-cancelled",
  "badge-run-superseded",
  "runs-filter",
  "run-list",
  "run-row",
  "run-main",
  "run-state",
  "run-times",
  "run-link",
  "run-notice",
  "run-detail",
  "run-facts",
  "run-question",
  "run-log",
  "pr-picker",
  "pr-list",
  "pr-row",
  "pr-number",
  "pr-title",
  "admin-nav",
  "admin-nav-list",
  "checklist",
  "checklist-item",
] as const;

const REMOVED = new Set<string>(REMOVED_CLASS_NAMES);

export type LegacyClassFinding = {
  /** The removed class name as it was written. */
  className: string;
  /** The 1-based line of the use. */
  line: number;
};

// A class attribute with a plain string, or the string arguments of the class helpers. The
// template-literal form of `className` is covered by the same group.
const CLASS_ATTRIBUTE =
  /\b(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`))/g;

// A helper call `cn`/`clsx`/`cva`: only the opening parenthesis is matched here. The arguments are
// read as a whole (`helperArguments`), because a removed class can sit in any of them, not only the
// first.
const CLASS_HELPER_START = /\b(?:cn|clsx|cva)\s*\(/g;
const STRING_LITERAL = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** The `[start, end)` of each class helper call's argument list, quotes respected so a `)` inside a string does not end it. */
function helperArguments(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  CLASS_HELPER_START.lastIndex = 0;
  for (const match of content.matchAll(CLASS_HELPER_START)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    for (let index = open; index < content.length; index += 1) {
      const char = content[index]!;
      if (quote !== null) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          ranges.push([open + 1, index]);
          break;
        }
      }
    }
  }
  return ranges;
}

function findingsIn(
  classes: string,
  at: number,
  content: string,
): LegacyClassFinding[] {
  const findings: LegacyClassFinding[] = [];
  for (const token of classes.split(/\s+/)) {
    // A variant prefix (`md:card`) still carries the class after the colon.
    const bare = token.slice(token.lastIndexOf(":") + 1);
    if (REMOVED.has(bare))
      findings.push({ className: bare, line: lineOf(content, at) });
  }
  return findings;
}

/** The removed class names of the file's class contexts, with their line. */
export function findRemovedClasses(content: string): LegacyClassFinding[] {
  const findings: LegacyClassFinding[] = [];
  for (const match of content.matchAll(CLASS_ATTRIBUTE)) {
    const classes = match.slice(1).find((value) => value !== undefined) ?? "";
    findings.push(...findingsIn(classes, match.index, content));
  }
  for (const [start, end] of helperArguments(content)) {
    const body = content.slice(start, end);
    STRING_LITERAL.lastIndex = 0;
    for (const literal of body.matchAll(STRING_LITERAL)) {
      const classes = literal[1] ?? literal[2] ?? literal[3] ?? "";
      findings.push(...findingsIn(classes, start + literal.index, content));
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** The removed class names used as a CSS class selector (`.btn`, `.card:hover`, ...), with their line. */
export function findRemovedSelectors(content: string): LegacyClassFinding[] {
  const findings: LegacyClassFinding[] = [];
  for (const match of content.matchAll(
    /(^|[^.\w-])\.([a-z][a-z0-9-]*)(?![\w-])/gm,
  )) {
    const name = match[2]!;
    if (REMOVED.has(name))
      findings.push({ className: name, line: lineOf(content, match.index) });
  }
  return findings.sort((a, b) => a.line - b.line);
}
