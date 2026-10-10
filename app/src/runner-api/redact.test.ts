// Pins down the last line of defense against a secret in a stored result. The runner redacts its
// own output; this removes what still looks like a credential, and the secrets the app itself knows.
import { describe, expect, it } from "vitest";
import { REDACTED, redactResult, redactText } from "./redact.ts";
import type { RunnerResult } from "./contract.ts";

describe("removing secrets from text", () => {
  it("replaces GitHub tokens of every kind", () => {
    const text =
      "ghs_abcdefghijklmnopqrstuvwxyz0123 ghp_abcdefghijklmnopqrstuvwxyz0123 github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz";

    expect(redactText(text, [])).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it("replaces provider keys and bearer credentials", () => {
    const text =
      "key sk-or-v1-abcdef0123456789abcdef0123456789 and Authorization: Bearer abcdefghijklmnop0123456789";

    expect(redactText(text, [])).toBe(
      `key ${REDACTED} and Authorization: ${REDACTED}`,
    );
  });

  it("replaces the exact secrets it is given, wherever they appear", () => {
    const text =
      "the value hunter2-secret-value appears twice: hunter2-secret-value.";

    expect(redactText(text, ["hunter2-secret-value"])).toBe(
      `the value ${REDACTED} appears twice: ${REDACTED}.`,
    );
  });

  it("ignores given secrets that are too short to be real, so ordinary words survive", () => {
    expect(redactText("a short word", ["a", "", "short"])).toBe("a short word");
  });

  it("leaves ordinary text untouched", () => {
    const text =
      "Reviewed 3 files.\nSee https://github.com/acme/widgets/pull/7";

    expect(redactText(text, ["some-longer-secret"])).toBe(text);
  });
});

describe("removing secrets from a result", () => {
  const result: RunnerResult = {
    ok: false,
    durationMs: 10,
    commentUrl: null,
    errorCode: "command_failed",
    errorMessage: "failed with ghs_abcdefghijklmnopqrstuvwxyz0123",
    logTail:
      "token ghs_abcdefghijklmnopqrstuvwxyz0123 refused; key my-llm-secret-key",
    logTruncated: false,
    usage: null,
  };

  it("cleans the free text fields and keeps everything else", () => {
    const cleaned = redactResult(result, ["my-llm-secret-key"]);

    expect(cleaned.logTail).toBe(`token ${REDACTED} refused; key ${REDACTED}`);
    expect(cleaned.errorMessage).toBe(`failed with ${REDACTED}`);
    expect({ ...cleaned, logTail: "", errorMessage: null }).toStrictEqual({
      ...result,
      logTail: "",
      errorMessage: null,
    });
  });

  it("gives the same answer when it is applied twice, so a repeated report compares equal", () => {
    const once = redactResult(result, ["my-llm-secret-key"]);

    expect(redactResult(once, ["my-llm-secret-key"])).toStrictEqual(once);
  });
});
