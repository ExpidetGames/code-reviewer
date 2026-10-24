// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// "Connect the App" (#182): the two ways to connect GitHub are alternatives, so only the chosen one
// renders. A segmented control (the kit's Tabs) picks between the one-click manifest flow and the
// manual form; the inactive path is not mounted, so its fields never sit next to the other path's.
import { useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs.tsx";
import type { GithubConfigView } from "../service.ts";
import type { GithubApi } from "./api.ts";
import { ManifestForm } from "./manifest-form.tsx";
import { ManualForm } from "./manual-form.tsx";

export type ConnectPath = "one-click" | "manual";

export function ConnectApp({
  view,
  suggestedName,
  tenancy,
  api,
}: {
  view: GithubConfigView;
  suggestedName: string;
  tenancy: "single" | "multi";
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const [path, setPath] = useState<ConnectPath>("one-click");
  return (
    <Tabs value={path} onValueChange={(value) => setPath(value as ConnectPath)}>
      <TabsList aria-label="How to connect the App">
        <TabsTrigger value="one-click">One-click (recommended)</TabsTrigger>
        <TabsTrigger value="manual">Enter values by hand</TabsTrigger>
      </TabsList>
      <TabsContent value="one-click">
        <ManifestForm
          suggestedName={suggestedName}
          configured={view.source !== "none"}
          tenancy={tenancy}
          {...(api === undefined ? {} : { api })}
        />
      </TabsContent>
      <TabsContent value="manual">
        <ManualForm view={view} {...(api === undefined ? {} : { api })} />
      </TabsContent>
    </Tabs>
  );
}
