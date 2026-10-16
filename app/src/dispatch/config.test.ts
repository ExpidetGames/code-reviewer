// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DISPATCH_CONFIG_ERROR_CODES,
  DispatchConfigError,
  dispatchConfigProblems,
  loadDispatchConfig,
} from "./config.ts";

const SECRET = "dispatch-signing-secret-0123456789abcdef";
const PREVIOUS = "dispatch-previous-secret-0123456789abcd";
const URL_OK = "https://dispatcher.example.test/dispatch";

const webhook = (extra: Record<string, string> = {}) => ({
  RUNNER_DISPATCH: "webhook",
  RUNNER_WEBHOOK_URL: URL_OK,
  RUNNER_WEBHOOK_SECRET: SECRET,
  ...extra,
});

describe("the dispatch settings", () => {
  // #326-T07
  it("default to poll mode, whatever else is set", () => {
    expect(loadDispatchConfig({})).toEqual({ mode: "poll" });
    expect(loadDispatchConfig({ RUNNER_DISPATCH: "" })).toEqual({
      mode: "poll",
    });
    expect(loadDispatchConfig({ RUNNER_DISPATCH: " Poll " })).toEqual({
      mode: "poll",
    });
    expect(loadDispatchConfig({ RUNNER_WEBHOOK_URL: "not a url" })).toEqual({
      mode: "poll",
    });
    expect(dispatchConfigProblems({ RUNNER_WEBHOOK_SECRET: "short" })).toEqual(
      [],
    );
  });

  // #326-T01
  it("read the webhook target, the current key and the key id", () => {
    expect(loadDispatchConfig(webhook())).toEqual({
      mode: "webhook",
      url: URL_OK,
      currentKey: { kid: "k1", secret: SECRET },
    });
    expect(
      loadDispatchConfig(
        webhook({
          RUNNER_WEBHOOK_KEY_ID: "k2",
          RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k1",
          RUNNER_WEBHOOK_SECRET_PREVIOUS: PREVIOUS,
          RUNNER_WEBHOOK_BYPASS_TOKEN:
            "bypass-token-for-the-protection-0123456789",
        }),
      ),
    ).toEqual({
      mode: "webhook",
      url: URL_OK,
      currentKey: { kid: "k2", secret: SECRET },
      previousKey: { kid: "k1", secret: PREVIOUS },
      bypassToken: "bypass-token-for-the-protection-0123456789",
    });
  });

  // #326-T08
  it("refuse webhook mode without a URL or a secret, naming only the variables", () => {
    expect(dispatchConfigProblems({ RUNNER_DISPATCH: "webhook" })).toEqual([
      "RUNNER_WEBHOOK_URL is not set",
      "RUNNER_WEBHOOK_SECRET is not set",
    ]);
  });

  // #326-T08
  it("refuse a short secret, a secret with white space and a URL that is not https", () => {
    const short = "short-secret-value";
    const problems = dispatchConfigProblems({
      RUNNER_DISPATCH: "webhook",
      RUNNER_WEBHOOK_URL: "http://dispatcher.example.test/dispatch",
      RUNNER_WEBHOOK_SECRET: short,
    });
    expect(problems).toEqual([
      "RUNNER_WEBHOOK_URL must be an https URL without credentials",
      "RUNNER_WEBHOOK_SECRET must be at least 32 characters long",
    ]);
    expect(JSON.stringify(problems)).not.toContain(short);
    expect(JSON.stringify(problems)).not.toContain("dispatcher.example.test");
    expect(
      dispatchConfigProblems(
        webhook({ RUNNER_WEBHOOK_SECRET: `${SECRET} with a space` }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_SECRET must not contain white space or control characters",
    ]);
  });

  // #326-T08
  it("accept plain http only for a loopback host and refuse credentials in the URL", () => {
    for (const url of [
      "http://localhost:3201/dispatch",
      "http://127.0.0.1:3201/dispatch",
      "http://[::1]:3201/dispatch",
    ])
      expect(
        dispatchConfigProblems(webhook({ RUNNER_WEBHOOK_URL: url })),
      ).toEqual([]);
    for (const url of [
      "https://user:pw@dispatcher.example.test/dispatch",
      "ftp://dispatcher.example.test/dispatch",
      "dispatcher.example.test/dispatch",
    ])
      expect(
        dispatchConfigProblems(webhook({ RUNNER_WEBHOOK_URL: url })),
      ).toEqual([
        "RUNNER_WEBHOOK_URL must be an https URL without credentials",
      ]);
  });

  // #326-T08
  it("refuse a secret that is the same as another credential and name that variable", () => {
    for (const name of [
      "RUNNER_TOKEN",
      "APP_SECRET",
      "BETTER_AUTH_SECRET",
      "OPERATOR_API_TOKEN",
      "CRON_SECRET",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "LLM_API_KEY",
    ]) {
      const problems = dispatchConfigProblems(webhook({ [name]: SECRET }));
      expect(problems).toEqual([
        `RUNNER_WEBHOOK_SECRET must differ from ${name}`,
      ]);
      expect(JSON.stringify(problems)).not.toContain(SECRET);
    }
  });

  // #326-T08
  it("refuse a previous key that is incomplete, weak, a copy of the current one or of another credential", () => {
    expect(
      dispatchConfigProblems(
        webhook({ RUNNER_WEBHOOK_SECRET_PREVIOUS: PREVIOUS }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_KEY_ID_PREVIOUS is required with RUNNER_WEBHOOK_SECRET_PREVIOUS",
    ]);
    expect(
      dispatchConfigProblems(webhook({ RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k0" })),
    ).toEqual([
      "RUNNER_WEBHOOK_SECRET_PREVIOUS is required with RUNNER_WEBHOOK_KEY_ID_PREVIOUS",
    ]);
    expect(
      dispatchConfigProblems(
        webhook({
          RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k0",
          RUNNER_WEBHOOK_SECRET_PREVIOUS: "short",
        }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_SECRET_PREVIOUS must be at least 32 characters long",
    ]);
    expect(
      dispatchConfigProblems(
        webhook({
          RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k0",
          RUNNER_WEBHOOK_SECRET_PREVIOUS: SECRET,
        }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_SECRET_PREVIOUS must differ from RUNNER_WEBHOOK_SECRET",
    ]);
    expect(
      dispatchConfigProblems(
        webhook({
          RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k1",
          RUNNER_WEBHOOK_SECRET_PREVIOUS: PREVIOUS,
        }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_KEY_ID_PREVIOUS must differ from RUNNER_WEBHOOK_KEY_ID",
    ]);
    expect(
      dispatchConfigProblems(
        webhook({
          RUNNER_WEBHOOK_KEY_ID_PREVIOUS: "k0",
          RUNNER_WEBHOOK_SECRET_PREVIOUS: PREVIOUS,
          RUNNER_TOKEN: PREVIOUS,
        }),
      ),
    ).toEqual(["RUNNER_WEBHOOK_SECRET_PREVIOUS must differ from RUNNER_TOKEN"]);
  });

  // #326-T08
  it("refuse a key id that the receiver would not accept, and an unknown mode", () => {
    for (const kid of ["K1", "-k", "a b", "k".repeat(33)])
      expect(
        dispatchConfigProblems(webhook({ RUNNER_WEBHOOK_KEY_ID: kid })),
      ).toEqual([
        "RUNNER_WEBHOOK_KEY_ID must be 1 to 32 characters of a-z, 0-9, _ or -, starting with a letter or digit",
      ]);
    expect(dispatchConfigProblems({ RUNNER_DISPATCH: "push" })).toEqual([
      'RUNNER_DISPATCH must be "poll" or "webhook"',
    ]);
  });

  // #326-T08
  it("refuse a bypass token that is unusable or the same as a signing secret", () => {
    expect(
      dispatchConfigProblems(
        webhook({ RUNNER_WEBHOOK_BYPASS_TOKEN: "has space inside the token" }),
      ),
    ).toEqual([
      "RUNNER_WEBHOOK_BYPASS_TOKEN must not contain white space or control characters",
    ]);
    expect(
      dispatchConfigProblems(webhook({ RUNNER_WEBHOOK_BYPASS_TOKEN: SECRET })),
    ).toEqual([
      "RUNNER_WEBHOOK_BYPASS_TOKEN must differ from RUNNER_WEBHOOK_SECRET",
    ]);
  });

  // #326-T08
  it("throw DISPATCH_CONFIG_INVALID with the variables named and no value in the message", () => {
    let caught: unknown;
    try {
      loadDispatchConfig(webhook({ RUNNER_TOKEN: SECRET }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DispatchConfigError);
    const error = caught as DispatchConfigError;
    expect(DISPATCH_CONFIG_ERROR_CODES).toContain(error.code);
    expect(error.code).toBe("DISPATCH_CONFIG_INVALID");
    expect(error.message).toContain(
      "RUNNER_WEBHOOK_SECRET must differ from RUNNER_TOKEN",
    );
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("dispatcher.example.test");
  });
});
