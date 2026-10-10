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

export class IntegrationError extends Error {
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
