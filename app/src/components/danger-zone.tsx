// SPDX-License-Identifier: Apache-2.0

// A destructive action at the bottom ("danger zone"): a Card with the destructive treatment and the
// confirmation in an AlertDialog, which traps the focus and returns it to the opener on close. The
// composition is ours (Apache-2.0); Card and AlertDialog come from `components/ui/`.
"use client";

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function DangerZone({
  title,
  description,
  actionLabel,
  confirmTitle,
  confirmDescription,
  confirmLabel = "Confirm",
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  /** The label of the button that opens the confirmation. */
  actionLabel: string;
  confirmTitle: string;
  confirmDescription: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
      <CardContent className="flex justify-end">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">{actionLabel}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => onConfirm()}
              >
                {confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
