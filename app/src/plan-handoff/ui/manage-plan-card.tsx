// SPDX-License-Identifier: Apache-2.0

// The "Manage plan" card of the General settings (#284): one plain form that posts to the handoff route of the
// workspace (src/plan-handoff/http.ts), whose answer is a redirect to the operator-configured page. It is rendered
// only for an Owner or Admin while the instance has such a page (the page decides, from the role and the setting), so
// there is nothing to hide here: no field, no address of the page and no token in the markup.
import { Button } from "../../components/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export function ManagePlanCard({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <Card role="region" aria-labelledby="plan-heading">
      <CardHeader>
        <CardTitle>
          <h2
            id="plan-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Plan
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          The plan of this workspace is managed on an operator-configured page.
          You arrive there as an Owner or Admin of this workspace, with a link
          that works once and for five minutes.
        </p>
        <form
          method="post"
          action={`/api/w/${encodeURIComponent(workspaceSlug)}/plan-handoff`}
          className="flex"
        >
          <Button type="submit">Manage plan</Button>
        </form>
      </CardContent>
    </Card>
  );
}
