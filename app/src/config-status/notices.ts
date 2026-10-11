// SPDX-License-Identifier: Apache-2.0

// The copy of the configuration hints. The status holds variable names and stable codes; this turns
// them into the sentences a person reads (the UI translates codes, never the other way round). Never
// a value: a hint names what to fix, not what is there.
import type { LlmConfigIssue, LlmConfigIssueCode } from "../llm/config.ts";
import type { ConfigStatus } from "./status.ts";

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

/** What is wrong with the configuration, in the order a person should fix it; empty when nothing is. */
export function describeConfigNotices(status: ConfigStatus): ConfigNotice[] {
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
  const llmIssues = status.llm.configured ? [] : status.llm.issues;
  for (const issue of [...llmIssues, ...status.llm.warnings])
    notices.push(llmNotice(issue));
  return notices;
}
