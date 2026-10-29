// SPDX-License-Identifier: LicenseRef-Proprietary

// The log line levels the webhook route uses. The default writes to the console; tests pass
// their own to read the lines. Nothing that reaches a logger may contain the webhook secret, a
// signature, a body or a token: lines name the delivery id, the event and the outcome only.
export type WebhookLogger = {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
};

export const consoleWebhookLogger: WebhookLogger = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};
