// SPDX-License-Identifier: Apache-2.0

// A row action that may not be undone (remove a member, leave, revoke an invitation): it opens an
// AlertDialog that names what will happen and only runs the call on the confirming button (#177, R23
// "destructive actions confirmed"). The dialog traps the focus and returns it to the row button on
// close; the row button keeps its distinct accessible name so repeated rows stay apart.
"use client";

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
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/button.tsx";

export function ConfirmAction({
  actionLabel,
  actionName,
  title,
  description,
  confirmLabel,
  onConfirm,
  disabled = false,
}: {
  /** The visible text of the row button, for example "Remove". */
  actionLabel: string;
  /** The accessible name of the row button; it names the row, for example "Remove ada@example.test". */
  actionName: string;
  /** The question in the dialog, for example "Remove ada@example.test?". */
  title: string;
  /** One sentence on what the action does. */
  description: string;
  /** The visible text of the confirming button, for example "Leave the workspace". */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          aria-label={actionName}
          disabled={disabled}
        >
          {actionLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
