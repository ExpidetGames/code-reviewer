// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The old in-app deep link was `/w/:ws/settings#llm-access` (#178 review N3). The fragment never reaches
// the server, so a bookmark of it opens the settings index ("General") with a dead hash. This sends such
// a visit on to the LLM sub-page once, on the client, and renders nothing.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { workspacePath } from "../paths.ts";

export const LEGACY_LLM_HASH = "#llm-access";

export function LegacyLlmHashRedirect({
  workspaceSlug,
}: {
  workspaceSlug: string;
}) {
  const router = useRouter();
  useEffect(() => {
    if (window.location.hash === LEGACY_LLM_HASH)
      router.replace(workspacePath(workspaceSlug, "/settings/llm"));
  }, [router, workspaceSlug]);
  return null;
}
