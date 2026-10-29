// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the configuration hints. The status holds variable names and stable codes; this turns
// them into the sentences a person reads (the UI translates codes, never the other way round). Never
// a value: a hint names what to fix, not what is there.
import type { LlmConfigIssue, LlmConfigIssueCode } from "../llm/config.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import type { ConfigAudience, ConfigStatus } from "./status.ts";

export type ConfigNotice = {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail: string;
};

/** The one owner of the "GitHub is not set up" fact (#169); every screen that needs it imports it. */
export const GITHUB_NOT_CONFIGURED_TITLE = "GitHub is not set up yet";
export const GITHUB_NOT_CONFIGURED_COPY =
  "The GitHub App is not set up yet. Ask your admin to set it up.";

export const LLM_ISSUE_COPY: Record<
  LlmConfigIssueCode,
  {
    severity: "error" | "warning";
    title: string;
    detail: (v: string) => string;
  }
> = {
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
      title: GITHUB_NOT_CONFIGURED_TITLE,
      detail: `${GITHUB_NOT_CONFIGURED_COPY} Repositories cannot be read from GitHub and projects cannot be activated until then.`,
    });
  return notices;
}

/**
 * What is wrong with the configuration, in the order a person should fix it; empty when nothing is. The
 * default audience is the member: the names of the variables are for the operator, who has to ask for them.
 */
export function describeConfigNotices(
  product: ProductIdentity,
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
      detail:
        variables.length === 0
          ? `GitHub is not connected yet. A ${product.name} admin connects it under Integrations in the admin portal. Until then repositories cannot be read from GitHub and projects cannot be activated.`
          : `${kind === "missing" ? "Missing" : "Not valid"}: ${variables.join(", ")}. Repositories cannot be read from GitHub and projects cannot be activated until this is fixed (a ${product.name} admin does that under Integrations in the admin portal).`,
    });
  }
  // The LLM access is a matter of the workspace now (its own key, `src/llm/`), and its hint is shown by the
  // workspace pages (`LlmAccessNotice`). The instance only has the model options, and a wrong one is a
  // warning.
  for (const issue of status.llm.warnings) notices.push(llmNotice(issue));
  return notices;
}
