// SPDX-License-Identifier: Apache-2.0

// The copy of the configuration hints. The status holds variable names and stable codes; this turns
// them into the sentences a person reads (the UI translates codes, never the other way round). Never
// a value: a hint names what to fix, not what is there.
import type { LlmConfigIssue, LlmConfigIssueCode } from "../llm/config.ts";
import type { ConfigAudience, ConfigStatus } from "./status.ts";

export type ConfigNotice = {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail: string;
};

export const LLM_ISSUE_COPY: Record<
  LlmConfigIssueCode,
  {
    severity: "error" | "warning";
    title: string;
    detail: (v: string) => string;
  }
> = {
  LLM_API_KEY_MISSING: {
    severity: "error",
    title: "LLM key missing",
    detail: (variable) =>
      `Set ${variable} on the server. Until then every review fails before it starts.`,
  },
  LLM_API_KEY_INVALID: {
    severity: "error",
    title: "LLM key not valid",
    detail: (variable) =>
      `${variable} is set but cannot be used (no spaces or control characters, at most 4096 characters). Every review fails until it is fixed.`,
  },
  LLM_PROVIDER_MISSING: {
    severity: "error",
    title: "LLM provider missing",
    detail: (variable) =>
      `Set ${variable} (only "openrouter" is supported). Until then every review fails before it starts.`,
  },
  LLM_PROVIDER_UNKNOWN: {
    severity: "error",
    title: "LLM provider not supported",
    detail: (variable) =>
      `${variable} must be "openrouter". Every review fails until it is fixed.`,
  },
  LLM_MODEL_INVALID: {
    severity: "warning",
    title: "LLM model setting ignored",
    detail: (variable) =>
      `${variable} is not a model name, so the default model is used.`,
  },
  LLM_MAX_TOKENS_INVALID: {
    severity: "warning",
    title: "LLM context window setting ignored",
    detail: (variable) =>
      `${variable} is not a whole number in the allowed range, so it is ignored.`,
  },
};

function llmNotice(issue: LlmConfigIssue): ConfigNotice {
  const copy = LLM_ISSUE_COPY[issue.code];
  return {
    id: issue.code,
    severity: copy.severity,
    title: copy.title,
    detail: copy.detail(issue.variable),
  };
}

/**
 * The LLM access is a matter of the workspace now (its own key, `src/llm/`), and its hint is shown by the
 * workspace pages (`LlmAccessNotice`). An absent `LLM_*` variable is therefore no problem of the instance. What
 * the instance admin still hears about is a legacy variable that is set but wrong, and an optional one that is
 * ignored.
 */
const ABSENT_LLM_ISSUES: readonly LlmConfigIssueCode[] = [
  "LLM_API_KEY_MISSING",
  "LLM_PROVIDER_MISSING",
];

/**
 * What a member of a workspace is told: that a part is not set up and who to ask, and nothing of how the
 * instance is configured (no variable name, no warning about a setting that is ignored). Whether reviews can run
 * is said by the workspace's own hint (`LlmAccessNotice`).
 */
function describeNoticesForMembers(status: ConfigStatus): ConfigNotice[] {
  const notices: ConfigNotice[] = [];
  if (!status.githubApp.configured)
    notices.push({
      id: "github_app",
      severity: "error",
      title: "GitHub is not set up yet",
      detail:
        "Ask your instance admin to set it up. Repositories cannot be read from GitHub and projects cannot be activated until then.",
    });
  return notices;
}

/**
 * What is wrong with the configuration, in the order a person should fix it; empty when nothing is. The
 * default audience is the member: the names of the variables are for the operator, who has to ask for them.
 */
export function describeConfigNotices(
  status: ConfigStatus,
  audience: ConfigAudience = "member",
): ConfigNotice[] {
  if (audience === "member") return describeNoticesForMembers(status);
  const notices: ConfigNotice[] = [];
  if (!status.githubApp.configured) {
    const { kind, variables } = status.githubApp;
    notices.push({
      id: "github_app",
      severity: "error",
      title:
        kind === "missing"
          ? "GitHub App not configured"
          : "GitHub App settings not valid",
      detail: `${kind === "missing" ? "Missing" : "Not valid"}: ${variables.join(", ")}. Repositories cannot be read from GitHub and projects cannot be activated until this is fixed.`,
    });
  }
  const llmIssues = status.llm.configured
    ? []
    : status.llm.issues.filter(
        (issue) => !ABSENT_LLM_ISSUES.includes(issue.code),
      );
  for (const issue of [...llmIssues, ...status.llm.warnings])
    notices.push(llmNotice(issue));
  return notices;
}
