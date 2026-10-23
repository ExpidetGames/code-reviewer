// SPDX-License-Identifier: Apache-2.0

"use client";
// The play button of a project row and the dialog it opens (#655): the open pull requests of the
// repository, one to pick, "Start review". It is the only way to start a review by hand. The panel
// inside is mounted only while the dialog is open, so each opening loads the pull requests again. A
// project that is not active shows the button disabled, with the reason as its description.
import { PlayIcon } from "@phosphor-icons/react/dist/ssr";
import { useId, useState } from "react";
import { Button } from "../../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import type { ManualReviewApi } from "./api.ts";
import { StartReviewPanel } from "./start-review-panel.tsx";

export const START_REVIEW_INACTIVE_COPY =
  "Switch the project on to start a review.";

export function StartReviewDialog({
  workspaceSlug,
  repositoryId,
  fullName,
  startable,
  api,
}: {
  workspaceSlug: string;
  repositoryId: string;
  /** Untrusted GitHub text; rendered as text only. */
  fullName: string;
  /** Whether a review can be started now: only an active project. */
  startable: boolean;
  /** Only tests pass this. */
  api?: ManualReviewApi;
}) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const label = `Start a review of ${fullName}`;
  if (!startable)
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-describedby={reasonId}
          disabled
        >
          <PlayIcon aria-hidden="true" />
        </Button>
        <span id={reasonId} className="sr-only">
          {START_REVIEW_INACTIVE_COPY}
        </span>
      </>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label}>
          <PlayIcon aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a review</DialogTitle>
          <DialogDescription>
            Pick an open pull request of {fullName}.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <StartReviewPanel
            workspaceSlug={workspaceSlug}
            repositoryId={repositoryId}
            {...(api === undefined ? {} : { api })}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
