// Stable error codes of the integrations layer. Callers branch on `code`, never on the message.
export const INTEGRATION_ERROR_CODES = [
  "INTEGRATION_TYPE_UNKNOWN",
  "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
  "INTEGRATION_CONFIG_INVALID",
  "INTEGRATION_SECRET_NOT_ALLOWED",
  "INTEGRATION_ALREADY_EXISTS",
  "INTEGRATION_NOT_FOUND",
  "INTEGRATION_EXTERNAL_ID_REQUIRED",
  "INTEGRATION_STATUS_INVALID",
  "INTEGRATION_PULL_REQUEST_NOT_FOUND",
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/**
 * Marks an error whose message is known to be free of secrets (it names calls, statuses and
 * variable names, never a key, token or response body), so it may be logged and shown as it is. Any
 * error without the marker is reduced to a generic line wherever it is reported.
 */
export type SafeMessageError = Error & { readonly safeMessage: true };

export function hasSafeMessage(error: unknown): error is SafeMessageError {
  return (
    error instanceof Error &&
    (error as { safeMessage?: unknown }).safeMessage === true
  );
}

export class IntegrationError extends Error implements SafeMessageError {
  readonly safeMessage = true as const;
  readonly code: IntegrationErrorCode;

  constructor(
    code: IntegrationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IntegrationError";
    this.code = code;
  }
}
