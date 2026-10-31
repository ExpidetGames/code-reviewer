// SPDX-License-Identifier: LicenseRef-Proprietary

// What the stored result of a turn gives its session (#754): the last commit that is on the remote, the saved agent session and the
// summary. Read from the result as it is stored, after the checks and the redaction, by the transaction that completes the job. A
// result without the block, or one that cannot be read, gives nothing: `recordTurnResult` keeps what is stored for a `null` and
// still sets the session idle. Never throws.
import type { TurnResult } from "../db/repositories/implementer-repository.ts";
import type { JsonValue } from "../integrations/types.ts";

const NOTHING: TurnResult = { headCommit: null, opencode: null, summary: null };
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function recordOf(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

export function turnResultOf(result: JsonValue | null | undefined): TurnResult {
  const block = recordOf(recordOf(result)?.implementer);
  if (block === null) return NOTHING;
  const head = block.headCommit;
  // `headCommit` is the last commit of the branch; the session names the last one that reached the remote.
  const headCommit =
    block.pushed === true && typeof head === "string" && COMMIT_SHA.test(head)
      ? head
      : null;
  const saved = recordOf(block.opencode);
  const opencode =
    saved !== null &&
    typeof saved.sessionId === "string" &&
    typeof saved.version === "string"
      ? { sessionId: saved.sessionId, version: saved.version }
      : null;
  const summary =
    typeof block.summary === "string" && block.summary !== ""
      ? block.summary
      : null;
  return { headCommit, opencode, summary };
}
