// SPDX-License-Identifier: Apache-2.0

// The instance facts of the General settings sub-page (#178): the tenancy, how many members the
// workspace has, and whether the GitHub App works, in plain words. For the instance admin: the names
// of the variables that are wrong, never a value (src/config-status/status.ts). For a member of a
// workspace only whether it is set up. (The LLM access is a matter of the workspace, with its own
// sub-page: src/llm/ui/.)
import { DescriptionList } from "../components/description-list.tsx";
import type { ReactNode } from "react";
import type { ConfigAudience, ConfigStatus } from "./status.ts";

function githubFact(status: ConfigStatus, audience: ConfigAudience): ReactNode {
  const { githubApp } = status;
  if (audience === "member")
    return githubApp.configured
      ? "Set up"
      : "Not set up yet. Ask your instance admin.";
  if (githubApp.configured)
    return (
      <>
        Configured (<span className="font-mono">{githubApp.slug}</span>)
      </>
    );
  if (githubApp.variables.length === 0) return "Not connected";
  return (
    <>
      {githubApp.kind === "missing" ? "Missing" : "Not valid"}:{" "}
      <span className="font-mono">{githubApp.variables.join(", ")}</span>
    </>
  );
}

export function InstanceStatus({
  status,
  audience = "member",
  tenancy,
  memberCount,
}: {
  status: ConfigStatus;
  audience?: ConfigAudience;
  /** The tenancy of the instance, when the page shows it. */
  tenancy?: "single" | "multi";
  /** How many people belong to the workspace, when the page shows it. */
  memberCount?: number;
}) {
  const items: Array<{ term: ReactNode; description: ReactNode }> = [];
  if (tenancy !== undefined)
    items.push({
      term: "Tenancy",
      description: tenancy === "multi" ? "Multi-tenant" : "Single-tenant",
    });
  if (memberCount !== undefined)
    items.push({ term: "Members", description: String(memberCount) });
  items.push({ term: "GitHub", description: githubFact(status, audience) });
  return <DescriptionList items={items} />;
}
