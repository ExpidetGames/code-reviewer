// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Dispatcher logs of a failed `vm-prepare.sh` (#473): the exit status and the end of its stderr, so that a
// failure in a VM is diagnosable from the log without the platform's own text. The script is ours and writes short
// diagnostics (docker/sandbox/vm-prepare.sh), but the tail is still treated as untrusted: reduced to printable
// text, masked by shape, capped and cut to the last lines. The log line goes through the logger's redaction as well.
import { redact } from "../core/logger.ts";

/** The event of the log line, next to the launch error code (`docker_not_ready`) that the caller branches on. */
export const VM_PREPARE_FAILED_EVENT = "vm_prepare_failed";
export const STDERR_TAIL_MAX_LINES = 6;
export const STDERR_TAIL_MAX_CHARS = 400;

const REDACTED = "[redacted]";
// Escape sequences, then every other control character but the line break.
// eslint-disable-next-line no-control-regex -- the point is to remove them
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- the point is to remove them
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
// A token, a key or a hash: a run of 32 or more characters of the usual token alphabets. The script writes none.
const TOKEN_LIKE = /[A-Za-z0-9+/=_-]{32,}/g;
// A prefixed token of a known vendor whose body may be shorter than that.
const PREFIXED = /\b(?:gh[pousr]|github_pat|sk|xox[a-z])[_-][A-Za-z0-9_-]{8,}/g;

/** The last lines of a stderr as one line of at most `STDERR_TAIL_MAX_CHARS`, secrets and control characters removed. */
export function stderrTail(stderr: string): string {
  const lines = stderr
    .replace(ESCAPES, "")
    .replace(/\r/g, "")
    .replace(CONTROLS, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-STDERR_TAIL_MAX_LINES)
    .map((line) =>
      redact(line, [])
        .replace(PREFIXED, REDACTED)
        .replace(TOKEN_LIKE, REDACTED),
    );
  const text = lines.join(" | ");
  return text.length <= STDERR_TAIL_MAX_CHARS
    ? text
    : `…${text.slice(-STDERR_TAIL_MAX_CHARS)}`;
}
