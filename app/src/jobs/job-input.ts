// SPDX-License-Identifier: Apache-2.0

// Checks what `enqueue` is given before anything is written. The values come from webhooks and
// comments, so nothing here trusts a type annotation: every field is looked at as `unknown`.
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import type { JobFieldError } from "./errors.ts";
import {
  JOB_TRIGGER_KINDS,
  type EnqueueJobInput,
  type JobTriggerKind,
} from "./job-types.ts";

/** More than a comment command can sensibly carry; the comment ticket truncates long questions earlier. */
export const JOB_ARGS_MAX_LENGTH = 10_000;

const HEAD_SHA = /^[0-9a-f]{40}$/i;

/** An input that passed the checks, with defaults filled in. */
export type ValidEnqueueInput = {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  /** Lower case. */
  headSha: string;
  command: ReviewCommand;
  args: string;
  triggerKind: JobTriggerKind;
  actorLogin: string;
  deliveryId: string | null;
  commentId: string | null;
  runAfter: Date | null;
};

export type EnqueueInputCheck =
  | { ok: true; value: ValidEnqueueInput }
  | { ok: false; fieldErrors: JobFieldError[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function validateEnqueueInput(
  input: EnqueueJobInput,
): EnqueueInputCheck {
  const fields = input as Partial<Record<keyof EnqueueJobInput, unknown>>;
  const fieldErrors: JobFieldError[] = [];
  const refuse = (field: string, code: JobFieldError["code"]) =>
    void fieldErrors.push({ field, code });

  if (!isNonEmptyString(fields.repositoryId))
    refuse("repositoryId", "required");

  const prNumber = fields.prNumber;
  if (
    typeof prNumber !== "number" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1
  )
    refuse("prNumber", "invalid");

  const prUrl = fields.prUrl;
  if (!isNonEmptyString(prUrl)) refuse("prUrl", "required");
  else if (!isHttpUrl(prUrl)) refuse("prUrl", "invalid");

  const headSha = fields.headSha;
  if (typeof headSha !== "string" || !HEAD_SHA.test(headSha))
    refuse("headSha", "invalid");

  const command = fields.command;
  if (command === undefined || command === null || command === "")
    refuse("command", "required");
  else if (!REVIEW_COMMANDS.some((known) => known === command))
    refuse("command", "invalid");

  const args = fields.args ?? "";
  if (typeof args !== "string") refuse("args", "invalid");
  else if (args.length > JOB_ARGS_MAX_LENGTH) refuse("args", "too_long");

  if (!JOB_TRIGGER_KINDS.some((kind) => kind === fields.triggerKind))
    refuse("triggerKind", "invalid");

  if (!isNonEmptyString(fields.actorLogin)) refuse("actorLogin", "required");

  const deliveryId = fields.deliveryId ?? null;
  if (deliveryId !== null && !isNonEmptyString(deliveryId))
    refuse("deliveryId", "invalid");

  const commentId = fields.commentId ?? null;
  if (commentId !== null && !isNonEmptyString(commentId))
    refuse("commentId", "invalid");

  const runAfter = fields.runAfter ?? null;
  if (
    runAfter !== null &&
    (!(runAfter instanceof Date) || Number.isNaN(runAfter.getTime()))
  )
    refuse("runAfter", "invalid");

  if (fieldErrors.length > 0) return { ok: false, fieldErrors };

  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      repositoryId: fields.repositoryId as string,
      prNumber: prNumber as number,
      prUrl: prUrl as string,
      headSha: (headSha as string).toLowerCase(),
      command: command as ReviewCommand,
      args: args as string,
      triggerKind: fields.triggerKind as JobTriggerKind,
      actorLogin: fields.actorLogin as string,
      deliveryId: deliveryId as string | null,
      commentId: commentId as string | null,
      runAfter: runAfter as Date | null,
    },
  };
}
